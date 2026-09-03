/**
 * Webhook endpoint registry — org-scoped delivery targets (issue #47, SPEC §53).
 *
 * Rules enforced here:
 *  - Pure functions only; time comes from the injected Clock, secret entropy
 *    from the injected `generateSecret` — never Date.now()/RNG in the core.
 *  - **URL as a validated value:** https required, loopback/localhost/link-local
 *    hosts refused (SSRF), userinfo credentials refused, length caps. The
 *    validator is hand-rolled and pure — no runtime URL globals.
 *  - **Secret semantics (the core):** the signing secret VALUE is returned
 *    ONCE by `registerEndpoint` and never stored; the endpoint record carries
 *    only a non-reversible reference produced by the injected `hashSecret`
 *    port (the domain refuses a hash port that returns the secret verbatim).
 *    No event ever carries the secret (pinned by test).
 *  - Lifecycle (issue #47): active | paused | revoked, `revoked` terminal —
 *    a revoked endpoint never plans or queues deliveries. Pause/resume/revoke
 *    take a mandatory reason (R3-style audit).
 *  - Subscriptions are appended to the endpoint; adding an existing pattern is
 *    IDEMPOTENT (same shape, no duplicate row, no event).
 */
import { DomainError, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  endpointPausedEvent,
  endpointRegisteredEvent,
  endpointResumedEvent,
  endpointRevokedEvent,
  subscriptionAddedEvent,
  webhookNow,
} from './events';
import type {
  EndpointPausedPayload,
  EndpointRegisteredPayload,
  EndpointResumedPayload,
  EndpointRevokedPayload,
  SubscriptionAddedPayload,
  WebhookEvent,
} from './events';
import { matchesSubscription, parseSubscriptionPattern } from './subscription';
import type { EventSubscription } from './subscription';

export type EndpointStatus = 'active' | 'paused' | 'revoked';

/** Terminal statuses — nothing transitions out of them. */
export const ENDPOINT_TERMINAL_STATUSES: readonly EndpointStatus[] = ['revoked'];

/* ------------------------------------------------------------------ *
 * Lane id helper (mirrors payments/ids.ts + paymentlinks/link.ts —
 * lanes never import lanes). Deterministic UUID-shaped id from a seed.
 * ------------------------------------------------------------------ */
const FNV_OFFSET = 0x811c9dc5n;
const FNV_PRIME = 0x01000193n;
const WORD_MASK = 0xffffffffn;

const fnv1a32 = (round: number, input: string): bigint => {
  let hash = FNV_OFFSET ^ BigInt(round);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & WORD_MASK;
  }
  return hash;
};

/** Deterministic UUID-shaped id (8-4-4-4-12 hex) derived from a seed. Pure. */
export const uuidFromSeed = (seed: string): Uuid => {
  const w = (round: number): string => fnv1a32(round, seed).toString(16).padStart(8, '0');
  const raw = `${w(0)}-${w(1).slice(0, 4)}-${w(1).slice(4, 8)}-${w(2).slice(0, 4)}-${w(2).slice(4, 8)}${w(3)}`;
  return uuid(raw);
};

/* ------------------------------------------------------------------ *
 * URL validation (pure — no runtime URL globals)
 * ------------------------------------------------------------------ */

export const MAX_URL_LENGTH = 2048;
export const MAX_LABEL_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 500;

const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;
const DNS_HOST_PATTERN = /^[a-z0-9.-]+$/;
const PORT_PATTERN = /^\d{1,5}$/;
/** Loopback / localhost / unspecified / link-local (cloud metadata) hosts. */
const isForbiddenHost = (host: string): boolean =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host.startsWith('127.') ||
  host === '0.0.0.0' ||
  host.startsWith('169.254.') ||
  host === '::1' ||
  host === '0:0:0:0:0:0:0:1';

/**
 * Validate a webhook target URL and return it unchanged (never silently
 * rewritten — what is configured is what gets signed and delivered).
 * Refusals: WEBHOOK_URL_TOO_LONG, WEBHOOK_URL_MALFORMED (unparseable shape,
 * embedded credentials, bad port), WEBHOOK_URL_INSECURE (non-https scheme),
 * WEBHOOK_URL_FORBIDDEN_HOST (localhost/loopback/link-local — SSRF guard).
 */
export const validateWebhookUrl = (raw: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError('WEBHOOK_URL_MALFORMED', 'a webhook endpoint requires a URL');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new DomainError('WEBHOOK_URL_TOO_LONG', `webhook URL must be at most ${MAX_URL_LENGTH} characters, got ${raw.length}`);
  }
  const scheme = URL_SCHEME_PATTERN.exec(raw);
  if (!scheme) {
    throw new DomainError('WEBHOOK_URL_MALFORMED', `webhook URL must be an absolute http(s) URL, got "${raw.slice(0, 64)}"`);
  }
  if (scheme[1]!.toLowerCase() !== 'https') {
    throw new DomainError('WEBHOOK_URL_INSECURE', `webhook endpoints require https, got ${scheme[1]!.toLowerCase()}://`);
  }
  const rest = raw.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.includes('@')) {
    throw new DomainError('WEBHOOK_URL_MALFORMED', 'webhook URLs must not embed credentials (userinfo)');
  }

  let host: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) {
      throw new DomainError('WEBHOOK_URL_MALFORMED', 'unterminated IPv6 host bracket');
    }
    host = authority.slice(1, close).toLowerCase();
    const after = authority.slice(close + 1);
    if (after !== '' && PORT_PATTERN.test(after.slice(1)) === false) {
      throw new DomainError('WEBHOOK_URL_MALFORMED', `invalid port after IPv6 host: "${after}"`);
    }
    if (!/^[0-9a-f:]+$/.test(host)) {
      throw new DomainError('WEBHOOK_URL_MALFORMED', `invalid IPv6 host "${host}"`);
    }
  } else {
    const colon = authority.lastIndexOf(':');
    host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
    if (host.length === 0) {
      throw new DomainError('WEBHOOK_URL_MALFORMED', 'webhook URL has an empty host');
    }
    if (!DNS_HOST_PATTERN.test(host)) {
      throw new DomainError('WEBHOOK_URL_MALFORMED', `webhook host "${host}" contains characters outside [a-z0-9.-]`);
    }
    if (colon !== -1) {
      const port = authority.slice(colon + 1);
      if (!PORT_PATTERN.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw new DomainError('WEBHOOK_URL_MALFORMED', `invalid port "${port}" (expected 1-65535)`);
      }
    }
  }
  if (isForbiddenHost(host)) {
    throw new DomainError(
      'WEBHOOK_URL_FORBIDDEN_HOST',
      `webhook host "${host}" is a loopback/localhost/link-local target — delivery targets must be reachable remote hosts`,
    );
  }
  return raw;
};

/* ------------------------------------------------------------------ *
 * Secret ports + registration
 * ------------------------------------------------------------------ */

/** Generated secrets: URL-safe, bounded (32–128 of [A-Za-z0-9_-]). */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
/** Secret references (hash outputs): URL-safe, bounded (8–128). */
export const SECRET_REF_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface SecretPorts {
  /** Entropy lives at the edge — the domain stays pure (mirrors TokenGenerator). */
  readonly generateSecret: () => string;
  /** Non-reversible reference/hash of the secret — records carry this, never the secret. */
  readonly hashSecret: (secret: string) => string;
}

export interface WebhookEndpoint {
  readonly endpointId: Uuid;
  readonly orgId: Uuid; // opaque — owning organization
  readonly url: string; // validated value (validateWebhookUrl)
  readonly label: string;
  readonly description: string | null;
  readonly status: EndpointStatus;
  /** Non-reversible secret reference — the plaintext secret never lives here. */
  readonly secretRef: string;
  readonly subscriptions: readonly EventSubscription[];
  readonly createdAt: Date;
  readonly pausedAt?: Date;
  readonly resumedAt?: Date;
  readonly revokedAt?: Date;
}

export interface RegisterEndpointCommand {
  readonly orgId: Uuid;
  readonly url: string;
  readonly label: string;
  readonly description?: string | null;
  readonly endpointId?: Uuid; // caller-supplied (preferred); deterministic fallback otherwise
}

export interface RegisterEndpointDeps extends SecretPorts {
  readonly clock: Clock;
}

export interface RegistrationResult {
  readonly endpoint: WebhookEndpoint;
  /** The plaintext signing secret — returned ONCE, never stored or emitted. */
  readonly secret: string;
  readonly events: readonly [WebhookEvent<'webhook.endpointRegistered', EndpointRegisteredPayload>];
}

const assertLabel = (label: string): string => {
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new DomainError('WEBHOOK_LABEL_REQUIRED', 'a webhook endpoint requires a label');
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new DomainError('WEBHOOK_LABEL_TOO_LONG', `label must be at most ${MAX_LABEL_LENGTH} characters, got ${label.length}`);
  }
  return label;
};

const assertDescription = (description?: string | null): string | null => {
  if (description === undefined || description === null) return null;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new DomainError(
      'WEBHOOK_DESCRIPTION_TOO_LONG',
      `description must be at most ${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`,
    );
  }
  return description;
};

/**
 * Register an endpoint. The generated secret is validated for shape, hashed
 * through the injected port into a stored reference, and returned ONCE here.
 */
export const registerEndpoint = (cmd: RegisterEndpointCommand, deps: RegisterEndpointDeps): RegistrationResult => {
  const url = validateWebhookUrl(cmd.url);
  const label = assertLabel(cmd.label);
  const description = assertDescription(cmd.description);

  const secret = deps.generateSecret();
  if (!SECRET_PATTERN.test(secret)) {
    throw new DomainError(
      'WEBHOOK_SECRET_MALFORMED',
      'endpoint signing secret must be 32-128 URL-safe characters ([A-Za-z0-9_-])',
    );
  }
  const secretRef = deps.hashSecret(secret);
  if (!SECRET_REF_PATTERN.test(secretRef)) {
    throw new DomainError(
      'WEBHOOK_SECRET_REF_MALFORMED',
      'hashSecret must produce a non-empty 8-128 URL-safe reference',
    );
  }
  if (secretRef === secret) {
    throw new DomainError(
      'WEBHOOK_HASH_NOT_IRREVERSIBLE',
      'hashSecret returned the secret verbatim — endpoint records would carry plaintext secret material',
    );
  }

  const createdAt = webhookNow(deps.clock);
  const endpoint: WebhookEndpoint = {
    endpointId: cmd.endpointId ?? uuidFromSeed(`webhook-endpoint:${cmd.orgId}:${url}:${label}`),
    orgId: cmd.orgId,
    url,
    label,
    description,
    status: 'active',
    secretRef,
    subscriptions: [],
    createdAt,
  };
  return {
    endpoint,
    secret,
    events: [
      endpointRegisteredEvent(
        {
          endpointId: endpoint.endpointId,
          orgId: endpoint.orgId,
          url: endpoint.url,
          label: endpoint.label,
          description: endpoint.description,
          secretRef: endpoint.secretRef,
        },
        deps.clock,
      ),
    ],
  };
};

/* ------------------------------------------------------------------ *
 * Lifecycle: active → paused → active; active|paused → revoked (terminal)
 * ------------------------------------------------------------------ */

const requireReason = (reason: string, op: string): string => {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) {
    throw new DomainError('WEBHOOK_REASON_REQUIRED', `a ${op} transition requires an explicit reason (R3)`);
  }
  return why;
};

export interface EndpointTransitionResult {
  readonly endpoint: WebhookEndpoint;
  readonly event:
    | WebhookEvent<'webhook.endpointPaused', EndpointPausedPayload>
    | WebhookEvent<'webhook.endpointResumed', EndpointResumedPayload>
    | WebhookEvent<'webhook.endpointRevoked', EndpointRevokedPayload>;
}

/** Admin: active → paused (mandatory reason). Paused endpoints plan nothing. */
export const pauseEndpoint = (endpoint: WebhookEndpoint, reason: string, clock: Clock): EndpointTransitionResult & {
  event: WebhookEvent<'webhook.endpointPaused', EndpointPausedPayload>;
} => {
  if (endpoint.status !== 'active') {
    throw new DomainError(
      'WEBHOOK_TRANSITION_INVALID',
      `cannot pause a ${endpoint.status} endpoint; only active endpoints pause`,
    );
  }
  const why = requireReason(reason, 'pause');
  const pausedAt = webhookNow(clock);
  return {
    endpoint: { ...endpoint, status: 'paused', pausedAt },
    event: endpointPausedEvent({ endpointId: endpoint.endpointId, orgId: endpoint.orgId, reason: why }, clock),
  };
};

/** Admin: paused → active (endpoint plans deliveries again). */
export const resumeEndpoint = (endpoint: WebhookEndpoint, clock: Clock): EndpointTransitionResult & {
  event: WebhookEvent<'webhook.endpointResumed', EndpointResumedPayload>;
} => {
  if (endpoint.status !== 'paused') {
    throw new DomainError(
      'WEBHOOK_TRANSITION_INVALID',
      `cannot resume a ${endpoint.status} endpoint; only paused endpoints resume`,
    );
  }
  const resumedAt = webhookNow(clock);
  return {
    endpoint: { ...endpoint, status: 'active', resumedAt },
    event: endpointResumedEvent({ endpointId: endpoint.endpointId, orgId: endpoint.orgId }, clock),
  };
};

/** Admin: active|paused → revoked (mandatory reason). Terminal — irreversible. */
export const revokeEndpoint = (endpoint: WebhookEndpoint, reason: string, clock: Clock): EndpointTransitionResult & {
  event: WebhookEvent<'webhook.endpointRevoked', EndpointRevokedPayload>;
} => {
  if (endpoint.status === 'revoked') {
    throw new DomainError('WEBHOOK_TRANSITION_INVALID', 'endpoint is revoked — revoked is terminal');
  }
  const why = requireReason(reason, 'revoke');
  const revokedAt = webhookNow(clock);
  return {
    endpoint: { ...endpoint, status: 'revoked', revokedAt },
    event: endpointRevokedEvent({ endpointId: endpoint.endpointId, orgId: endpoint.orgId, reason: why }, clock),
  };
};

/* ------------------------------------------------------------------ *
 * Subscriptions (grammar lives in subscription.ts; the ops act on the
 * endpoint aggregate, so they live here to keep imports one-directional)
 * ------------------------------------------------------------------ */

export interface AddSubscriptionResult {
  readonly endpoint: WebhookEndpoint;
  /** webhook.subscriptionAdded — null when the pattern was already present (idempotent replay). */
  readonly event: WebhookEvent<'webhook.subscriptionAdded', SubscriptionAddedPayload> | null;
}

/**
 * Append a subscription to the endpoint. Duplicate patterns are IDEMPOTENT:
 * same endpoint shape, no duplicate row, no event. Unknown prefixes and
 * malformed patterns throw their stable codes.
 */
export const addSubscription = (endpoint: WebhookEndpoint, pattern: string, clock: Clock): AddSubscriptionResult => {
  const { mode } = parseSubscriptionPattern(pattern);
  if (endpoint.subscriptions.some((s) => s.pattern === pattern)) {
    return { endpoint, event: null };
  }
  const subscription: EventSubscription = { pattern, mode, addedAt: webhookNow(clock) };
  return {
    endpoint: { ...endpoint, subscriptions: [...endpoint.subscriptions, subscription] },
    event: subscriptionAddedEvent(
      { endpointId: endpoint.endpointId, orgId: endpoint.orgId, pattern, mode },
      clock,
    ),
  };
};

/** Does the endpoint hold at least one subscription matching the event type? */
export const endpointSubscribedTo = (endpoint: WebhookEndpoint, eventType: string): boolean =>
  endpoint.subscriptions.some((s) => matchesSubscription(s.pattern, eventType));

/**
 * MessageTemplate — the versioned, immutable template registry (SPEC §26).
 *
 * Templates are how collections messages stay reviewable and reproducible:
 * a template's body carries `{{placeholder}}` slots, and every version ever
 * registered stays in the registry forever — "immutable" here means:
 *
 *   - a registered (orgId, name, channel, locale, version) row can NEVER be
 *     replaced or edited — re-registration is COMMS_TEMPLATE_VERSION_EXISTS,
 *     even with an identical body (the row identity is the audit fact);
 *   - returned rows are Object.freeze()d — mutation attempts throw TypeError;
 *   - newer versions never rewrite older ones: `findTemplate` by exact
 *     version keeps serving the pinned body, which is what a Message's
 *     templateRef (templateId + version) points at.
 *
 * renderTemplate is total and deterministic: unknown value keys are rejected
 * (COMMS_TEMPLATE_VALUE_UNKNOWN — typos never silently pass), missing values
 * are rejected (COMMS_TEMPLATE_VALUE_MISSING), and the same (template,
 * values) pair always renders byte-identical output. No I/O, no Date.now().
 */
import { DomainError, type Uuid } from '../shared';
import { assertCommsChannel, type CommsChannel } from './conversation';

export interface MessageTemplate {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly name: string;
  readonly channel: CommsChannel;
  /** BCP-47-ish locale tag, e.g. 'en-KE' | 'sw' — non-empty free text. */
  readonly locale: string;
  /** Body with `{{placeholder}}` slots; syntax validated at registration. */
  readonly body: string;
  readonly version: number; // 1..
  readonly createdAt: string; // ISO-8601, from the injected Clock
}

/** A message pins the EXACT template version it was rendered from. */
export interface TemplateRef {
  readonly templateId: Uuid;
  readonly version: number;
}

/** `{{name}}` — name is `[a-zA-Z0-9_]+`; surrounding whitespace allowed. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Extract the template's placeholders in order of first appearance,
 * de-duplicated. Throws COMMS_TEMPLATE_BODY_MALFORMED for any `{{` that does
 * not form a valid placeholder (unclosed, empty or invalid name) — bodies
 * with broken syntax must never reach the registry.
 */
export const extractPlaceholders = (body: string): string[] => {
  const seen: string[] = [];
  let rest = body;
  // Walk left-to-right; every '{{' must open a valid '{{name}}' immediately.
  for (let open = rest.indexOf('{{'); open !== -1; open = rest.indexOf('{{')) {
    const match = PLACEHOLDER.exec(rest.slice(open));
    PLACEHOLDER.lastIndex = 0; // global regex — reset between manual execs
    if (match === null) {
      throw new DomainError(
        'COMMS_TEMPLATE_BODY_MALFORMED',
        `malformed placeholder at offset ${open}: expected {{name}} with name matching [a-zA-Z0-9_]+`,
        { offset: open },
      );
    }
    const name = match[1];
    if (name !== undefined && !seen.includes(name)) {
      seen.push(name);
    }
    rest = rest.slice(open + match[0].length);
  }
  return seen;
};

const assertTemplateBody = (body: string): string => {
  if (!body.trim()) {
    throw new DomainError('COMMS_TEMPLATE_BODY_REQUIRED', 'a template body is required');
  }
  extractPlaceholders(body); // throws COMMS_TEMPLATE_BODY_MALFORMED
  return body;
};

const assertVersion = (version: number): number => {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      'COMMS_TEMPLATE_VERSION_INVALID',
      `template version must be a positive integer, got ${version}`,
      { version },
    );
  }
  return version;
};

// --- registry operations ------------------------------------------------------

export interface RegisterTemplateArgs {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly name: string;
  readonly channel: string;
  readonly locale: string;
  readonly body: string;
  readonly version: number;
}

const sameKey = (t: MessageTemplate, orgId: Uuid, name: string, channel: CommsChannel, locale: string): boolean =>
  t.orgId === orgId && t.name === name && t.channel === channel && t.locale === locale;

/**
 * Append a new immutable template row. Throws:
 *   - COMMS_CHANNEL_INVALID / COMMS_TEMPLATE_NAME_REQUIRED /
 *     COMMS_TEMPLATE_LOCALE_REQUIRED / COMMS_TEMPLATE_BODY_REQUIRED /
 *     COMMS_TEMPLATE_BODY_MALFORMED / COMMS_TEMPLATE_VERSION_INVALID —
 *     malformed input;
 *   - COMMS_TEMPLATE_ID_TAKEN — the row id already exists in the registry;
 *   - COMMS_TEMPLATE_VERSION_EXISTS — a row with the same
 *     (orgId, name, channel, locale, version) exists. Versions are
 *     immutable: bump the version instead of re-registering.
 */
export function registerTemplate(
  args: RegisterTemplateArgs,
  registry: readonly MessageTemplate[],
  clock: { now(): Date },
): MessageTemplate {
  const channel = assertCommsChannel(args.channel);
  if (!args.name.trim()) {
    throw new DomainError('COMMS_TEMPLATE_NAME_REQUIRED', 'a template name is required');
  }
  if (!args.locale.trim()) {
    throw new DomainError('COMMS_TEMPLATE_LOCALE_REQUIRED', 'a template locale is required');
  }
  const body = assertTemplateBody(args.body);
  const version = assertVersion(args.version);

  if (registry.some((t) => t.id === args.id)) {
    throw new DomainError('COMMS_TEMPLATE_ID_TAKEN', `template id already registered: ${args.id}`, {
      id: args.id,
    });
  }
  if (registry.some((t) => sameKey(t, args.orgId, args.name, channel, args.locale) && t.version === version)) {
    throw new DomainError(
      'COMMS_TEMPLATE_VERSION_EXISTS',
      `template ${args.name} (${channel}/${args.locale}) v${version} is already registered — versions are immutable`,
      { name: args.name, channel, locale: args.locale, version },
    );
  }
  return Object.freeze({
    id: args.id,
    orgId: args.orgId,
    name: args.name,
    channel,
    locale: args.locale,
    body,
    version,
    createdAt: clock.now().toISOString(),
  });
}

/** Highest registered version for a key; 1 when nothing exists yet. */
export const nextTemplateVersion = (
  registry: readonly MessageTemplate[],
  key: { orgId: Uuid; name: string; channel: CommsChannel; locale: string },
): number =>
  registry.reduce(
    (max, t) => (sameKey(t, key.orgId, key.name, key.channel, key.locale) && t.version > max ? t.version : max),
    0,
  ) + 1;

/** Exact-version lookup — what a Message's pinned templateRef resolves to. */
export const findTemplate = (
  registry: readonly MessageTemplate[],
  key: { orgId: Uuid; name: string; channel: CommsChannel; locale: string; version: number },
): MessageTemplate | null =>
  registry.find(
    (t) =>
      sameKey(t, key.orgId, key.name, key.channel, key.locale) && t.version === key.version,
  ) ?? null;

/** Latest registered version for a key, or null when none exists. */
export const latestTemplate = (
  registry: readonly MessageTemplate[],
  key: { orgId: Uuid; name: string; channel: CommsChannel; locale: string },
): MessageTemplate | null => {
  let best: MessageTemplate | null = null;
  for (const t of registry) {
    if (sameKey(t, key.orgId, key.name, key.channel, key.locale) && (best === null || t.version > best.version)) {
      best = t;
    }
  }
  return best;
};

// --- rendering ------------------------------------------------------------------

export interface RenderedMessage {
  /** Deterministic rendered body — same inputs, byte-identical output. */
  readonly body: string;
  /** Pins the exact template version the body was rendered from. */
  readonly templateRef: TemplateRef;
}

/**
 * Render a template against a value map. Rejections (deterministic, input
 * validation only):
 *   - COMMS_TEMPLATE_VALUE_UNKNOWN — `values` carries keys that are not
 *     placeholders of the template (typos never silently pass);
 *   - COMMS_TEMPLATE_VALUE_MISSING — a placeholder has no value.
 */
export const renderTemplate = (
  template: MessageTemplate,
  values: Readonly<Record<string, string>>,
): RenderedMessage => {
  const placeholders = extractPlaceholders(template.body);

  const unknown = Object.keys(values).filter((k) => !placeholders.includes(k));
  if (unknown.length > 0) {
    throw new DomainError(
      'COMMS_TEMPLATE_VALUE_UNKNOWN',
      `value key(s) ${unknown.map((k) => `'${k}'`).join(', ')} are not placeholders of template ${template.name} v${template.version}`,
      { unknown, templateId: template.id, version: template.version },
    );
  }

  const missing = placeholders.filter((p) => !(p in values));
  if (missing.length > 0) {
    throw new DomainError(
      'COMMS_TEMPLATE_VALUE_MISSING',
      `missing value(s) for placeholder(s) ${missing.map((p) => `'${p}'`).join(', ')}`,
      { missing, templateId: template.id, version: template.version },
    );
  }

  const body = template.body.replace(PLACEHOLDER, (_m, name: string) => values[name] ?? '');
  return { body, templateRef: { templateId: template.id, version: template.version } };
};

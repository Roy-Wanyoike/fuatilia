import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  MAX_LABEL_LENGTH,
  MAX_URL_LENGTH,
  addSubscription,
  endpointSubscribedTo,
  pauseEndpoint,
  registerEndpoint,
  resumeEndpoint,
  revokeEndpoint,
  validateWebhookUrl,
  type SecretPorts,
  type WebhookEndpoint,
} from './endpoint';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(501);
const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T08:05:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const ports: SecretPorts = {
  generateSecret: () => 'sk_whx_0123456789abcdef0123456789abcdef', // 36 URL-safe chars
  hashSecret: (secret) => `ref_${secret.length}_abc`,
};

const URL = 'https://hooks.example.co.ke/fuatilia';
const register = (overrides: Partial<Parameters<typeof registerEndpoint>[0]> = {}, clockIso = T0) =>
  registerEndpoint({ orgId: ORG, url: URL, label: 'Billing sink', ...overrides }, { ...ports, clock: at(clockIso) });

// --- URL validation -----------------------------------------------------------

describe('validateWebhookUrl — validated value (SSRF-guarded)', () => {
  it('accepts a plain https URL unchanged', () => {
    expect(validateWebhookUrl(URL)).toBe(URL);
  });

  it('refusal table', () => {
    expectCode(() => validateWebhookUrl(''), 'WEBHOOK_URL_MALFORMED');
    expectCode(() => validateWebhookUrl('hooks.example.co.ke/hook'), 'WEBHOOK_URL_MALFORMED');
    expectCode(() => validateWebhookUrl('https://user:pass@example.co.ke/hook'), 'WEBHOOK_URL_MALFORMED');
    expectCode(() => validateWebhookUrl('https://example.co.ke:70000/hook'), 'WEBHOOK_URL_MALFORMED');
    expectCode(() => validateWebhookUrl(`https://example.co.ke/${'x'.repeat(MAX_URL_LENGTH)}`), 'WEBHOOK_URL_TOO_LONG');
    expectCode(() => validateWebhookUrl('http://hooks.example.co.ke/hook'), 'WEBHOOK_URL_INSECURE');
    expectCode(() => validateWebhookUrl('ftp://hooks.example.co.ke/hook'), 'WEBHOOK_URL_INSECURE');
    expectCode(() => validateWebhookUrl('https://localhost/hook'), 'WEBHOOK_URL_FORBIDDEN_HOST');
    expectCode(() => validateWebhookUrl('https://sub.localhost/hook'), 'WEBHOOK_URL_FORBIDDEN_HOST');
    expectCode(() => validateWebhookUrl('https://127.0.0.1/hook'), 'WEBHOOK_URL_FORBIDDEN_HOST');
    expectCode(() => validateWebhookUrl('https://0.0.0.0/hook'), 'WEBHOOK_URL_FORBIDDEN_HOST');
    expectCode(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data'), 'WEBHOOK_URL_FORBIDDEN_HOST');
    expectCode(() => validateWebhookUrl('https://[::1]/hook'), 'WEBHOOK_URL_FORBIDDEN_HOST');
  });
});

// --- registration -------------------------------------------------------------

describe('registerEndpoint — secret semantics', () => {
  it('registers an active endpoint and returns the secret ONCE', () => {
    const { endpoint, secret, events } = register();
    expect(endpoint.status).toBe('active');
    expect(endpoint.url).toBe(URL);
    expect(endpoint.secretRef).toBe('ref_39_abc');
    expect(secret).toBe(ports.generateSecret());
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('webhook.endpointRegistered');
    expect(events[0]!.version).toBe(1);
    expect(events[0]!.aggregateId).toBe(endpoint.endpointId);
    expect(JSON.stringify(events[0]!.payload)).not.toContain(ports.generateSecret());
  });

  it('the stored secretRef is never the plaintext secret (irreversibility guard)', () => {
    expectCode(
      () =>
        registerEndpoint(
          { orgId: ORG, url: URL, label: 'sink' },
          { generateSecret: ports.generateSecret, hashSecret: (s) => s, clock: at(T0) },
        ),
      'WEBHOOK_HASH_NOT_IRREVERSIBLE',
    );
  });

  it('validation table — label, description, secret shape, hash-ref shape', () => {
    expectCode(() => register({ label: '   ' }), 'WEBHOOK_LABEL_REQUIRED');
    expectCode(() => register({ label: 'x'.repeat(MAX_LABEL_LENGTH + 1) }), 'WEBHOOK_LABEL_TOO_LONG');
    expectCode(() => register({ description: 'x'.repeat(501) }), 'WEBHOOK_DESCRIPTION_TOO_LONG');
    expectCode(
      () =>
        registerEndpoint(
          { orgId: ORG, url: URL, label: 'sink' },
          { generateSecret: () => 'too-short', hashSecret: ports.hashSecret, clock: at(T0) },
        ),
      'WEBHOOK_SECRET_MALFORMED',
    );
    expectCode(
      () =>
        registerEndpoint(
          { orgId: ORG, url: URL, label: 'sink' },
          { generateSecret: ports.generateSecret, hashSecret: () => 'tiny', clock: at(T0) },
        ),
      'WEBHOOK_SECRET_REF_MALFORMED',
    );
  });

  it('a broken injected clock is refused', () => {
    expectCode(
      () =>
        registerEndpoint(
          { orgId: ORG, url: URL, label: 'sink' },
          { ...ports, clock: { now: () => new Date('junk') } },
        ),
      'WEBHOOK_CLOCK_INVALID',
    );
  });
});

// --- lifecycle ------------------------------------------------------------------

describe('endpoint lifecycle — active ⇄ paused; revoked is terminal', () => {
  it('pause stamps a reason and emits webhook.endpointPaused', () => {
    const { endpoint } = register();
    const { endpoint: paused, event } = pauseEndpoint(endpoint, 'rotating target', at(T1));
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt?.toISOString()).toBe(T1);
    expect(event.name).toBe('webhook.endpointPaused');
    expect(event.payload.reason).toBe('rotating target');
  });

  it('resume returns the endpoint to active', () => {
    const { endpoint } = register();
    const paused = pauseEndpoint(endpoint, 'maintenance', at(T1)).endpoint;
    const { endpoint: resumed, event } = resumeEndpoint(paused, at(T1));
    expect(resumed.status).toBe('active');
    expect(resumed.resumedAt?.toISOString()).toBe(T1);
    expect(event.name).toBe('webhook.endpointResumed');
  });

  it('revoke is terminal and requires a reason', () => {
    const { endpoint } = register();
    const { endpoint: revoked, event } = revokeEndpoint(endpoint, 'offboarded', at(T1));
    expect(revoked.status).toBe('revoked');
    expect(event.name).toBe('webhook.endpointRevoked');
    expectCode(() => pauseEndpoint(revoked, 'again', at(T1)), 'WEBHOOK_TRANSITION_INVALID');
    expectCode(() => resumeEndpoint(revoked, at(T1)), 'WEBHOOK_TRANSITION_INVALID');
    expectCode(() => revokeEndpoint(revoked, 'again', at(T1)), 'WEBHOOK_TRANSITION_INVALID');
  });

  it('transition validation table', () => {
    const { endpoint } = register();
    expectCode(() => pauseEndpoint(endpoint, '   ', at(T1)), 'WEBHOOK_REASON_REQUIRED');
    expectCode(() => revokeEndpoint(endpoint, '', at(T1)), 'WEBHOOK_REASON_REQUIRED');
    expectCode(() => resumeEndpoint(endpoint, at(T1)), 'WEBHOOK_TRANSITION_INVALID'); // active, not paused
    const paused = pauseEndpoint(endpoint, 'pause', at(T1)).endpoint;
    expectCode(() => pauseEndpoint(paused, 'again', at(T1)), 'WEBHOOK_TRANSITION_INVALID');
  });
});

// --- subscriptions -----------------------------------------------------------------

describe('subscriptions on the endpoint aggregate', () => {
  const withEndpoint = (): WebhookEndpoint => register().endpoint;

  it('addSubscription appends and emits; duplicates are idempotent (no event)', () => {
    const endpoint = withEndpoint();
    const { endpoint: withSub, event } = addSubscription(endpoint, 'payment.*', at(T1));
    expect(withSub.subscriptions).toHaveLength(1);
    expect(event?.name).toBe('webhook.subscriptionAdded');
    expect(event?.payload.mode).toBe('wildcard');

    const replay = addSubscription(withSub, 'payment.*', at(T1));
    expect(replay.endpoint).toBe(withSub);
    expect(replay.event).toBeNull();

    const grown = addSubscription(withSub, 'payment.confirmed', at(T1));
    expect(grown.endpoint.subscriptions).toHaveLength(2);
    expect(grown.event).not.toBeNull();
  });

  it('malformed/unknown patterns throw their stable codes', () => {
    const endpoint = withEndpoint();
    expectCode(() => addSubscription(endpoint, 'unicorn.*', at(T1)), 'WEBHOOK_EVENT_PREFIX_UNKNOWN');
    expectCode(() => addSubscription(endpoint, 'payment..', at(T1)), 'WEBHOOK_SUBSCRIPTION_MALFORMED');
  });

  it('endpointSubscribedTo — exact and wildcard matching, whole segments', () => {
    let endpoint = withEndpoint();
    endpoint = addSubscription(endpoint, 'payment.*', at(T1)).endpoint;
    endpoint = addSubscription(endpoint, 'promise.broken', at(T1)).endpoint;
    expect(endpointSubscribedTo(endpoint, 'payment.identified')).toBe(true);
    expect(endpointSubscribedTo(endpoint, 'promise.broken')).toBe(true);
    expect(endpointSubscribedTo(endpoint, 'promise.fulfilled')).toBe(false);
    expect(endpointSubscribedTo(endpoint, 'payments.intakeConfirmed')).toBe(false);
  });
});

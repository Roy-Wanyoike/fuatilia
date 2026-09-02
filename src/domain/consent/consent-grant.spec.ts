import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  grantConsent,
  isActiveAt,
  revokeConsent,
  type ConsentGrant,
} from './consent-grant';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(101);
const OTHER = uid(102);

const T0 = '2026-02-02T08:00:00.000Z';
const T1 = '2026-02-02T09:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock0 = at(T0);
const clock1 = at(T1);

const grant = (
  id: number,
  channel: ConsentGrant['channel'],
  purpose: ConsentGrant['purpose'],
  customerId: Uuid = CUSTOMER,
  clock: Clock = clock0,
): ConsentGrant =>
  grantConsent({ id: uid(id), customerId, channel, purpose }, [], clock);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- grantConsent ------------------------------------------------------------

describe('grantConsent — appending the lawful-basis record (K3)', () => {
  it('appends an active grant stamped by the injected Clock', () => {
    const g = grant(1, 'whatsapp', 'dunning');
    expect(g).toEqual({
      id: uid(1),
      customerId: CUSTOMER,
      channel: 'whatsapp',
      purpose: 'dunning',
      grantedAt: new Date(T0),
      revokedAt: null,
    });
    expect(isActiveAt(g, new Date(T1))).toBe(true);
  });

  it('rejects a double-active grant for the same (customer, channel, purpose)', () => {
    const registry: ConsentGrant[] = [grant(1, 'sms', 'marketing')];
    // Table: every channel × purpose double-grant is refused with the stable code.
    for (const channel of ['whatsapp', 'sms', 'email'] as const) {
      for (const purpose of ['dunning', 'marketing'] as const) {
        const existing = grantConsent(
          { id: uid(20), customerId: CUSTOMER, channel, purpose },
          [],
          clock0,
        );
        expectCode(
          () => grantConsent({ id: uid(21), customerId: CUSTOMER, channel, purpose }, [existing], clock1),
          'CONSENT_ALREADY_ACTIVE',
        );
      }
    }
    // And the concrete case set up above.
    expectCode(
      () => grantConsent({ id: uid(22), customerId: CUSTOMER, channel: 'sms', purpose: 'marketing' }, registry, clock1),
      'CONSENT_ALREADY_ACTIVE',
    );
  });

  it('allows parallel grants across different triples and customers', () => {
    const registry: ConsentGrant[] = [
      grant(1, 'whatsapp', 'dunning'),
      grant(2, 'sms', 'dunning'),
      grant(3, 'whatsapp', 'marketing'),
    ];
    const next = grantConsent(
      { id: uid(4), customerId: OTHER, channel: 'whatsapp', purpose: 'dunning' },
      registry,
      clock1,
    );
    expect(next.customerId).toBe(OTHER);
    expect(registry).toHaveLength(3); // caller decides when to append; fn never mutates
  });

  it('never mutates the registry array it is given', () => {
    const registry: ConsentGrant[] = [];
    grantConsent({ id: uid(5), customerId: CUSTOMER, channel: 'email', purpose: 'dunning' }, registry, clock0);
    expect(registry).toHaveLength(0);
  });

  it('throws stable codes on invalid input', () => {
    const table: Array<[string, string, string]> = [
      ['telegram', 'dunning', 'CONSENT_CHANNEL_INVALID'],
      ['sms', 'transactional', 'CONSENT_PURPOSE_INVALID'],
      ['', 'dunning', 'CONSENT_CHANNEL_INVALID'],
    ];
    for (const [channel, purpose, code] of table) {
      expectCode(
        () =>
          grantConsent(
            { id: uid(6), customerId: CUSTOMER, channel: channel as never, purpose: purpose as never },
            [],
            clock0,
          ),
        code,
      );
    }
  });

  it('guards the K3 audit trail: grant ids are unique in the registry', () => {
    const existing = grant(7, 'email', 'marketing');
    expectCode(
      () =>
        grantConsent(
          { id: uid(7), customerId: CUSTOMER, channel: 'email', purpose: 'dunning' },
          [existing],
          clock0,
        ),
      'CONSENT_GRANT_ID_TAKEN',
    );
  });

  it('rejects a broken clock', () => {
    expectCode(
      () =>
        grantConsent(
          { id: uid(8), customerId: CUSTOMER, channel: 'sms', purpose: 'dunning' },
          [],
          { now: () => new Date('not-a-date') },
        ),
      'CONSENT_CLOCK_INVALID',
    );
  });
});

// --- revokeConsent -----------------------------------------------------------

describe('revokeConsent — append-only revocation (K3/R3)', () => {
  it('returns a NEW row with revokedAt set; the original grant is untouched', () => {
    const original = grant(9, 'whatsapp', 'dunning');
    const revoked = revokeConsent(original, clock1);

    expect(revoked).not.toBe(original);
    expect(revoked.revokedAt).toEqual(new Date(T1));
    expect(original.revokedAt).toBeNull(); // append-only: history keeps the live row
    expect(revoked.grantedAt).toEqual(original.grantedAt);
    expect(isActiveAt(revoked, new Date(T1))).toBe(false);
    expect(isActiveAt(original, new Date(T1))).toBe(true); // un-revoked row still active
  });

  it('refuses to revoke twice', () => {
    const revoked = revokeConsent(grant(10, 'sms', 'marketing'), clock1);
    expectCode(() => revokeConsent(revoked, clock1), 'CONSENT_ALREADY_REVOKED');
  });
});

// --- re-grant after revocation ----------------------------------------------

describe('re-grant after revocation — the K3 audit chain', () => {
  it('creates a NEW grant row; the old row stays revoked forever', () => {
    const first = grant(11, 'whatsapp', 'dunning');
    // Revocation REPLACES the row in the registry with its stamped copy (the
    // original object is kept intact for any journal that still holds it).
    const revokedRow = revokeConsent(first, clock1);
    const registry = [revokedRow];

    const second = grantConsent(
      { id: uid(12), customerId: CUSTOMER, channel: 'whatsapp', purpose: 'dunning' },
      registry,
      at('2026-03-01T10:00:00.000Z'),
    );

    expect(second.id).not.toBe(first.id);
    expect(second.grantedAt).toEqual(new Date('2026-03-01T10:00:00.000Z'));
    expect(second.revokedAt).toBeNull();
    expect(revokedRow.revokedAt).toEqual(new Date(T1)); // trail intact
    expect(first.revokedAt).toBeNull();
    expect(registry).toHaveLength(1); // one row per grant id — re-grant is a NEW row
  });

  it('still refuses while the previous grant is live (revocation is mandatory first)', () => {
    const first = grant(13, 'email', 'dunning');
    expectCode(
      () => grantConsent({ id: uid(14), customerId: CUSTOMER, channel: 'email', purpose: 'dunning' }, [first], clock1),
      'CONSENT_ALREADY_ACTIVE',
    );
  });
});

// --- isActiveAt --------------------------------------------------------------

describe('isActiveAt — time semantics', () => {
  const g: ConsentGrant = {
    id: uid(15),
    customerId: CUSTOMER,
    channel: 'sms',
    purpose: 'dunning',
    grantedAt: new Date('2026-01-01T00:00:00.000Z'),
    revokedAt: new Date('2026-06-01T00:00:00.000Z'),
  };

  it('is inactive before grantedAt, active from grantedAt, inactive from revokedAt', () => {
    const table: Array<[string, boolean]> = [
      ['2025-12-31T23:59:59.999Z', false],
      ['2026-01-01T00:00:00.000Z', true],
      ['2026-03-15T12:00:00.000Z', true],
      ['2026-05-31T23:59:59.999Z', true],
      ['2026-06-01T00:00:00.000Z', false], // withdrawal wins the exact tie
      ['2027-01-01T00:00:00.000Z', false],
    ];
    for (const [iso, expected] of table) {
      expect(isActiveAt(g, new Date(iso))).toBe(expected);
    }
  });

  it('treats a never-revoked grant as active from grantedAt onward', () => {
    const live = grant(16, 'whatsapp', 'marketing');
    expect(isActiveAt(live, new Date(T0))).toBe(true);
    expect(isActiveAt(live, new Date('2020-01-01T00:00:00.000Z'))).toBe(false);
  });
});

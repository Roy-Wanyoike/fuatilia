import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { grantConsent, revokeConsent, type ConsentGrant } from './consent-grant';
import { assertCanContact, assertWhatsAppDunningAllowed, type RefusalReason } from './guard';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(201);
const STRANGER = uid(202);

const T0 = '2026-02-02T08:00:00.000Z'; // grant time
const T1 = '2026-02-10T08:00:00.000Z'; // revoke time
const NOW = '2026-03-01T12:00:00.000Z'; // decision time
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const now = at(NOW);

/** Build a real registry through the append-only API (never hand-rolled rows). */
const registryWith = (...steps: Array<(grants: ConsentGrant[]) => ConsentGrant[]>): ConsentGrant[] =>
  steps.reduce((acc, step) => {
    const next = step(acc);
    return [...next];
  }, [] as ConsentGrant[]);

const add = (
  id: number,
  channel: ConsentGrant['channel'],
  purpose: ConsentGrant['purpose'],
  customerId: Uuid = CUSTOMER,
  clock: Clock = at(T0),
) => (grants: ConsentGrant[]): ConsentGrant[] => [
  ...grants,
  grantConsent({ id: uid(id), customerId, channel, purpose }, grants, clock),
];

const revoke = (id: number, clock: Clock = at(T1)) => (grants: ConsentGrant[]): ConsentGrant[] => {
  const target = grants.find((g) => g.id === uid(id));
  if (!target) throw new Error(`fixture bug: grant uid(${id}) not staged`);
  return [...grants.filter((g) => g.id !== uid(id)), revokeConsent(target, clock)];
};

const ask = (
  world: ConsentGrant[],
  channel: ConsentGrant['channel'],
  purpose: ConsentGrant['purpose'],
  customerId: Uuid = CUSTOMER,
) => assertCanContact(world, { customerId, channel, purpose }, now);

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

// --- decision table ----------------------------------------------------------

describe('assertCanContact — typed refusal table (every reason reachable)', () => {
  it('allows contact on an exact active grant and returns the supporting grant', () => {
    const world = registryWith(add(1, 'whatsapp', 'dunning'));
    const decision = ask(world, 'whatsapp', 'dunning');
    expect(decision).toEqual({ allowed: true, grant: world[0] });
    expect(decision.allowed && decision.grant.id).toBe(uid(1));
    expect(world).toHaveLength(1); // pure: registry untouched
  });

  it('refuses with the documented precedence', () => {
    const cases: Array<{
      name: string;
      world: ConsentGrant[];
      ask: { channel: ConsentGrant['channel']; purpose: ConsentGrant['purpose'] };
      reason: RefusalReason;
    }> = [
      {
        name: 'NO_GRANT — empty registry',
        world: [],
        ask: { channel: 'sms', purpose: 'dunning' },
        reason: 'NO_GRANT',
      },
      {
        name: 'NO_GRANT — other customers only',
        world: registryWith(add(2, 'sms', 'dunning', STRANGER)),
        ask: { channel: 'sms', purpose: 'dunning' },
        reason: 'NO_GRANT',
      },
      {
        name: 'NO_GRANT — grants exist elsewhere but nothing supports this contact',
        world: registryWith(add(3, 'email', 'marketing'), revoke(3)),
        ask: { channel: 'sms', purpose: 'dunning' },
        reason: 'NO_GRANT',
      },
      {
        name: 'REVOKED — exact grant revoked, no re-grant',
        world: registryWith(add(4, 'whatsapp', 'dunning'), revoke(4)),
        ask: { channel: 'whatsapp', purpose: 'dunning' },
        reason: 'REVOKED',
      },
      {
        name: 'WRONG_CHANNEL — dunning consented on sms, asked on whatsapp',
        world: registryWith(add(5, 'sms', 'dunning')),
        ask: { channel: 'whatsapp', purpose: 'dunning' },
        reason: 'WRONG_CHANNEL',
      },
      {
        name: 'WRONG_PURPOSE — marketing consented on whatsapp, asked for dunning',
        world: registryWith(add(6, 'whatsapp', 'marketing')),
        ask: { channel: 'whatsapp', purpose: 'dunning' },
        reason: 'WRONG_PURPOSE',
      },
    ];
    for (const c of cases) {
      const decision = ask(c.world, c.ask.channel, c.ask.purpose);
      expect(decision.allowed, c.name).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason, c.name).toBe(c.reason);
        expect(typeof decision.detail, c.name).toBe('string');
        expect(decision.detail.length, c.name).toBeGreaterThan(0);
      }
    }
  });

  it('REVOKED wins over WRONG_CHANNEL/WRONG_PURPOSE (precedence rule 1)', () => {
    // whatsapp/dunning revoked; sms/dunning + whatsapp/marketing still active.
    const world = registryWith(
      add(7, 'whatsapp', 'dunning'),
      add(8, 'sms', 'dunning'),
      add(9, 'whatsapp', 'marketing'),
      revoke(7),
    );
    const decision = ask(world, 'whatsapp', 'dunning');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('REVOKED');
  });

  it('a re-grant after revocation restores the allowed decision', () => {
    const world = registryWith(
      add(10, 'sms', 'marketing'),
      revoke(10),
      add(11, 'sms', 'marketing', CUSTOMER, at(T1)),
    );
    const decision = ask(world, 'sms', 'marketing');
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.grant.id).toBe(uid(11)); // the NEW row supports contact, not the revoked one
      expect(decision.grant.revokedAt).toBeNull();
    }
  });

  it('a pending (future-dated) grant is not consent yet', () => {
    const world = registryWith(add(12, 'email', 'dunning', CUSTOMER, at('2027-01-01T00:00:00.000Z')));
    const decision = ask(world, 'email', 'dunning');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NO_GRANT');
  });

  it('throws stable codes only on invalid input — never for refusals', () => {
    expectCode(() => assertCanContact([], { customerId: CUSTOMER, channel: 'voice' as never, purpose: 'dunning' }, now), 'CONSENT_CHANNEL_INVALID');
    expectCode(() => assertCanContact([], { customerId: CUSTOMER, channel: 'sms', purpose: 'nudges' as never }, now), 'CONSENT_PURPOSE_INVALID');
    expectCode(
      () => assertCanContact([], { customerId: CUSTOMER, channel: 'sms', purpose: 'dunning' }, { now: () => new Date('nope') }),
      'CONSENT_CLOCK_INVALID',
    );
    // Refusals are values:
    const refused = assertCanContact([], { customerId: CUSTOMER, channel: 'sms', purpose: 'dunning' }, now);
    expect(refused.allowed).toBe(false);
  });
});

// --- K2: WhatsApp dunning gate ----------------------------------------------

describe('WhatsApp dunning gate (K2 — Meta policy)', () => {
  it('REQUIRES an explicit active whatsapp/dunning grant', () => {
    const world = registryWith(add(20, 'whatsapp', 'dunning'));
    expect(assertWhatsAppDunningAllowed(world, CUSTOMER, now).allowed).toBe(true);
  });

  it('marketing opt-in never unlocks dunning', () => {
    const world = registryWith(add(21, 'whatsapp', 'marketing'));
    const decision = assertWhatsAppDunningAllowed(world, CUSTOMER, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('WRONG_PURPOSE');
  });

  it('dunning consented on another channel never unlocks WhatsApp', () => {
    const world = registryWith(add(22, 'sms', 'dunning'), add(23, 'email', 'dunning'));
    const decision = assertWhatsAppDunningAllowed(world, CUSTOMER, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('WRONG_CHANNEL');
  });

  it('a revoked WhatsApp dunning grant stops the dunning run (K3 append-only trail)', () => {
    const world = registryWith(add(24, 'whatsapp', 'dunning'), revoke(24));
    const decision = assertWhatsAppDunningAllowed(world, CUSTOMER, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('REVOKED');
      expect(decision.detail).toContain('revoked');
    }
  });
});

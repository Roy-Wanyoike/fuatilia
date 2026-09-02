import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../shared';
import { uuid } from '../shared';
import { grantConsent, revokeConsent, type ConsentGrant } from './consent-grant';
import { consentTrail } from './dsar';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(301);
const OTHER = uid(302);

const at = (iso: string): Clock => ({ now: () => new Date(iso) });

interface Step {
  id: number;
  channel: ConsentGrant['channel'];
  purpose: ConsentGrant['purpose'];
  at: string;
  customerId?: Uuid;
  revokeAt?: string;
}

/** Registry built only through the append-only API, with a controllable clock. */
const build = (steps: Step[]): ConsentGrant[] =>
  steps.reduce<ConsentGrant[]>((acc, step) => {
    const granted = grantConsent(
      {
        id: uid(step.id),
        customerId: step.customerId ?? CUSTOMER,
        channel: step.channel,
        purpose: step.purpose,
      },
      acc,
      at(step.at),
    );
    const all = [...acc, granted];
    if (step.revokeAt === undefined) return all;
    const target = all.find((g) => g.id === uid(step.id));
    if (!target) throw new Error('fixture bug: grant vanished');
    return [...all.filter((g) => g.id !== uid(step.id)), revokeConsent(target, at(step.revokeAt))];
  }, []);

// --- projection ---------------------------------------------------------------

describe('consentTrail — DSAR subject-access projection (K3)', () => {
  it('returns empty arrays for a customer with no recorded consent', () => {
    const trail = consentTrail([], CUSTOMER);
    expect(trail).toEqual({ customerId: CUSTOMER, granted: [], revoked: [], active: [] });
  });

  it('excludes other customers’ rows', () => {
    const registry: ConsentGrant[] = [
      grantConsent(
        { id: uid(1), customerId: OTHER, channel: 'sms', purpose: 'dunning' },
        [],
        at('2026-01-01T00:00:00.000Z'),
      ),
    ];
    const trail = consentTrail(registry, CUSTOMER);
    expect(trail.granted).toHaveLength(0);
    expect(trail.active).toHaveLength(0);
    expect(consentTrail(registry, OTHER).granted).toHaveLength(1);
  });

  it('orders granted[] chronologically regardless of registry order (deterministic tie-break)', () => {
    const registry = build([
      { id: 3, channel: 'sms', purpose: 'marketing', at: '2026-03-01T00:00:00.000Z' },
      { id: 1, channel: 'whatsapp', purpose: 'dunning', at: '2026-01-01T00:00:00.000Z' },
      { id: 2, channel: 'email', purpose: 'dunning', at: '2026-02-01T00:00:00.000Z' },
    ]);
    const trail = consentTrail(registry, CUSTOMER);
    expect(trail.granted.map((g) => g.grantId)).toEqual([uid(1), uid(2), uid(3)]);
    expect(trail.granted.map((g) => g.channel)).toEqual(['whatsapp', 'email', 'sms']);
    expect(trail.granted.map((g) => g.grantedAt)).toEqual([
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
    ]);

    // Two rows at the same instant still come out in a stable (id-ordered) way.
    const tied = consentTrail(
      build([
        { id: 11, channel: 'sms', purpose: 'dunning', at: '2026-01-01T00:00:00.000Z' },
        { id: 10, channel: 'email', purpose: 'marketing', at: '2026-01-01T00:00:00.000Z' },
      ]),
      CUSTOMER,
    );
    expect(tied.granted.map((g) => g.grantId)).toEqual([uid(10), uid(11)]);
  });

  it('orders revoked[] chronologically and keeps the grant→revocation linkage', () => {
    const registry = build([
      {
        id: 4,
        channel: 'whatsapp',
        purpose: 'dunning',
        at: '2026-01-01T00:00:00.000Z',
        revokeAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 5,
        channel: 'sms',
        purpose: 'marketing',
        at: '2026-02-01T00:00:00.000Z',
        revokeAt: '2026-03-01T00:00:00.000Z',
      },
      { id: 6, channel: 'email', purpose: 'dunning', at: '2026-02-15T00:00:00.000Z' },
    ]);
    const trail = consentTrail(registry, CUSTOMER);
    expect(trail.revoked.map((r) => r.grantId)).toEqual([uid(5), uid(4)]);
    expect(trail.revoked[0]).toEqual({
      grantId: uid(5),
      channel: 'sms',
      purpose: 'marketing',
      revokedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(trail.active.map((g) => g.id)).toEqual([uid(6)]);
  });

  it('projects the full granted→revoked→re-granted lifecycle (K3 audit chain)', () => {
    const registry = build([
      {
        id: 7,
        channel: 'whatsapp',
        purpose: 'dunning',
        at: '2026-01-01T00:00:00.000Z',
        revokeAt: '2026-02-01T00:00:00.000Z',
      },
      { id: 8, channel: 'whatsapp', purpose: 'dunning', at: '2026-03-01T00:00:00.000Z' },
      { id: 9, channel: 'sms', purpose: 'dunning', at: '2026-03-01T00:00:00.000Z' },
    ]);
    const trail = consentTrail(registry, CUSTOMER);

    expect(trail.granted).toHaveLength(3);
    expect(trail.revoked).toHaveLength(1);
    expect(trail.active).toHaveLength(2);

    expect(trail.revoked[0]?.grantId).toBe(uid(7)); // the OLD row carries the revocation
    expect(trail.active.map((g) => g.id).sort()).toEqual([uid(8), uid(9)].sort());
    expect(trail.active.every((g) => g.revokedAt === null)).toBe(true);
  });

  it('is a pure projection: the registry is neither mutated nor reordered', () => {
    const registry = build([
      { id: 12, channel: 'email', purpose: 'marketing', at: '2026-02-01T00:00:00.000Z' },
      { id: 13, channel: 'sms', purpose: 'dunning', at: '2026-01-01T00:00:00.000Z' },
    ]);
    const snapshot = [...registry];
    const first = consentTrail(registry, CUSTOMER);
    const second = consentTrail(registry, CUSTOMER);
    expect(registry).toEqual(snapshot);
    expect(first).toEqual(second);
    expect(first.granted.map((g) => g.channel)).toEqual(['sms', 'email']);
  });
});

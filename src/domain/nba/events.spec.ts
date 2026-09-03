import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { domainEvent, type DomainEvent } from './events';
import { rankNextBestActions } from './rank';
import { recordOutcome } from './feedback';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CLOCK_ISO = '2026-03-15T09:30:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

const bundle = () => ({
  orgId: uid(961),
  customerId: uid(962),
  receivableId: uid(963),
  amountMinor: 1_000_000,
  currency: 'KES',
  ageDays: 10,
  riskClass: 'moderate',
  paymentHistory: { onTime: 8, late: 2, unpaid: 0 },
} as const);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// --- envelope contract -----------------------------------------------------------------

describe('nba event envelope contract', () => {
  it('nba.recommendationCreated: repo envelope, plan aggregate, clock instant, narrow payload', () => {
    const p = rankNextBestActions(bundle(), { clock });
    const event = p.events[0]!;
    expect(event.name).toBe('nba.recommendationCreated');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(p.planId); // the plan is the NBA aggregate
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.occurredAt).toMatch(ISO_INSTANT);
    // narrow + serializable: dates as ISO strings, money as minor-unit numbers, ids only
    expect(Object.keys(event.payload).sort()).toEqual([
      'alternatives', 'amountMinor', 'createdAt', 'currency', 'customerId', 'orgId',
      'planId', 'policyEvidence', 'receivableId', 'recommendedAction', 'recommendedScore',
    ]);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('nba.actionOutcomeRecorded: repo envelope, plan aggregate, both instants in the payload', () => {
    const p = rankNextBestActions(bundle(), { clock });
    const recorded = recordOutcome([], p, 'paid', new Date('2026-03-20T10:00:00.000Z'), clock);
    const event = recorded.events[0]!;
    expect(event.name).toBe('nba.actionOutcomeRecorded');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(p.planId);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.occurredAt).toMatch(ISO_INSTANT);
    expect(Object.keys(event.payload).sort()).toEqual([
      'action', 'customerId', 'occurredAt', 'orgId', 'outcome', 'planId', 'receivableId', 'recordedAt',
    ]);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('nba.duplicateOutcomeObserved: the R9 tripwire travels the same envelope', () => {
    const p = rankNextBestActions(bundle(), { clock });
    const first = recordOutcome([], p, 'paid', new Date(), clock);
    const replay = recordOutcome(first.facts, p, 'paid', new Date(), clockAt('2026-03-16T00:00:00.000Z'));
    const event = replay.events[0]!;
    expect(event.name).toBe('nba.duplicateOutcomeObserved');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(p.planId);
    expect(event.occurredAt).toBe('2026-03-16T00:00:00.000Z');
    expect(event.payload).toEqual({ planId: p.planId, outcome: 'paid', seenAt: '2026-03-16T00:00:00.000Z' });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('carries the policy evidence in the payload (the audit trail that NBA honored policy)', () => {
    const p = rankNextBestActions(bundle(), {
      clock,
      policyDecisions: [
        { action: 'call', decision: 'deny', reasonCode: 'F20_VOICE_BLOCKED_FOR_SEGMENT' },
        { action: 'sms', decision: 'requires_approval', reasonCode: 'F20_SMS_SIGNOFF' },
      ],
    });
    const payload = p.events[0]!.payload;
    expect(payload.recommendedAction).not.toBe('call'); // denial honored — next-best won
    expect(payload.policyEvidence).toEqual([
      { action: 'call', reasonCode: 'F20_VOICE_BLOCKED_FOR_SEGMENT', decision: 'deny' },
      { action: 'sms', reasonCode: 'F20_SMS_SIGNOFF', decision: 'requires_approval' },
    ]);
  });

  it('domainEvent validates the injected Clock itself (NBA_CLOCK_INVALID, never a raw TypeError)', () => {
    const id = uid(964);
    expectCode(() => domainEvent('nba.recommendationCreated', id, {}, undefined as unknown as Clock), 'NBA_CLOCK_INVALID');
    expectCode(() => domainEvent('nba.recommendationCreated', id, {}, { now: () => 'garbage' } as unknown as Clock), 'NBA_CLOCK_INVALID');
    expectCode(() => domainEvent('nba.recommendationCreated', id, {}, { now: () => new Date('bogus') }), 'NBA_CLOCK_INVALID');
  });

  it('the factory stamps version 1 and the passed aggregate id for any lane event', () => {
    const id = uid(965);
    const event = domainEvent<'nba.actionOutcomeRecorded', { planId: Uuid }>('nba.actionOutcomeRecorded', id, { planId: id }, clock);
    const typed: DomainEvent<'nba.actionOutcomeRecorded', { planId: Uuid }> = event;
    expect(typed.version).toBe(1);
    expect(typed.aggregateId).toBe(id);
    expect(typed.payload.planId).toBe(id);
    expect(typed.occurredAt).toMatch(ISO_INSTANT);
  });
});

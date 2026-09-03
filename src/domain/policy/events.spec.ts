/**
 * Policy-lane events — the repo envelope contract and the JSON-safety guard
 * for monetary payload values (issue #34).
 */
import { describe, expect, it } from 'vitest';
import { DomainError, uuid, type Clock, type Uuid } from '../shared';
import { POLICY_DECISION_RECORDED, domainEvent, minorToNumber } from './events';
import type { DecisionRecordedPayload } from './events';

// --- fixtures -----------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const T0 = '2026-03-04T10:30:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

const payload: DecisionRecordedPayload = {
  orgId: ORG,
  customerId: uid(2),
  receivableId: null,
  caseId: null,
  actionType: 'send_whatsapp',
  actorType: 'ai_agent',
  autonomous: true,
  riskClass: 'low',
  amountMinor: null,
  currency: null,
  channel: 'whatsapp',
  decision: 'allow',
  reasonCode: 'POLICY_AUTONOMOUS_LOW_RISK',
  matchedRuleIds: ['default-allow-autonomous-low-risk'],
  ruleSetVersion: 1,
  requestedAt: T0,
};

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the envelope -----------------------------------------------------------------

describe('policy event envelope', () => {
  it('pins the audit event name', () => {
    expect(POLICY_DECISION_RECORDED).toBe('policy.decisionRecorded');
  });

  it('builds the repo envelope { name, version: 1, aggregateId, occurredAt, payload }', () => {
    const event = domainEvent(POLICY_DECISION_RECORDED, ORG, payload, clock);
    expect(event).toEqual({
      name: 'policy.decisionRecorded',
      version: 1,
      aggregateId: ORG,
      occurredAt: T0,
      payload,
    });
  });

  it('takes occurredAt ONLY from the injected clock (never Date.now)', () => {
    const later: Clock = { now: () => new Date('2026-03-04T23:59:59.999Z') };
    expect(domainEvent(POLICY_DECISION_RECORDED, ORG, payload, later).occurredAt).toBe('2026-03-04T23:59:59.999Z');
  });

  it('rejects a broken clock', () => {
    expectCode(
      () => domainEvent(POLICY_DECISION_RECORDED, ORG, payload, { now: () => new Date('garbage') }),
      'POLICY_CLOCK_INVALID',
    );
  });

  it('serializes to JSON without loss (narrow, PII-free by construction)', () => {
    const event = domainEvent(POLICY_DECISION_RECORDED, ORG, payload, clock);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});

// --- minorToNumber -----------------------------------------------------------------

describe('minorToNumber — the JSON-safety guard', () => {
  it('passes safe integers through unchanged', () => {
    expect(minorToNumber(0)).toBe(0);
    expect(minorToNumber(10_000_001)).toBe(10_000_001);
    expect(minorToNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s with POLICY_AMOUNT_NOT_SAFE_INTEGER',
    (bad) => {
      expectCode(() => minorToNumber(bad), 'POLICY_AMOUNT_NOT_SAFE_INTEGER');
    },
  );
});

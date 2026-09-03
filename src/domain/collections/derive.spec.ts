import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { openCase, transitionCase, type CollectionsCase } from './case';
import { deriveCaseStatus, type DisputeFact, type PromiseFact } from './derive';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const R1 = uid(951);
const R2 = uid(952);
const R99 = uid(999);
const COLLECTOR = uid(971);

const T0 = '2026-04-01T08:00:00.000Z';
const clock0: Clock = { now: () => new Date(T0) };

const caseAt = (status: 'open' | 'in_progress' | 'resolved' | 'closed_inactive', receivables: readonly Uuid[] = [R1]): CollectionsCase => {
  const opened = openCase(
    { id: uid(840), orgId: ORG, receivableIds: receivables, collectorId: COLLECTOR, openedBy: 'agent-7', sequenceNo: 1 },
    [],
    clock0,
  ).case;
  if (status === 'open') return opened;
  const engaged = transitionCase(opened, 'in_progress', { reason: 'engaged', actorId: 'agent-7' }, clock0).case;
  if (status === 'in_progress') return engaged;
  return transitionCase(engaged, status, { reason: 'done', actorId: 'agent-7' }, clock0).case;
};

const promise = (receivableId: Uuid, status: PromiseFact['status']): PromiseFact => ({ receivableId, status });
const dispute = (receivableId: Uuid, open: boolean): DisputeFact => ({ receivableId, open });

// --- the derived-status matrix ---------------------------------------------------

describe('deriveCaseStatus — WAITING / PROMISED / DISPUTED are derived, never stored', () => {
  it('the aggregate never stores a derived status (stored lifecycle stays minimal)', () => {
    for (const status of ['open', 'in_progress'] as const) {
      expect(caseAt(status).status).not.toBe('promised');
      expect(caseAt(status, [R1]).status).toBe(status);
    }
  });

  it('a live case with no holding facts is waiting', () => {
    expect(deriveCaseStatus(caseAt('open'))).toBe('waiting');
    expect(deriveCaseStatus(caseAt('in_progress'), { promiseFacts: [], disputeFacts: [] })).toBe('waiting');
  });

  it('a pending promise on a covered receivable → promised', () => {
    const c = caseAt('in_progress', [R1, R2]);
    expect(deriveCaseStatus(c, { promiseFacts: [promise(R2, 'pending')] })).toBe('promised');
  });

  it.each([
    ['fulfilled', promise(R1, 'fulfilled')],
    ['broken — a broken promise is NOT a promise (response = escalation, not a stored state)', promise(R1, 'broken')],
  ])('a %s promise leaves the case waiting', (_label, fact) => {
    expect(deriveCaseStatus(caseAt('in_progress'), { promiseFacts: [fact] })).toBe('waiting');
  });

  it('an open dispute on a covered receivable → disputed (SPEC §29 pause)', () => {
    expect(deriveCaseStatus(caseAt('in_progress'), { disputeFacts: [dispute(R1, true)] })).toBe('disputed');
  });

  it('a closed dispute (open: false) does not pause the case', () => {
    expect(deriveCaseStatus(caseAt('in_progress'), { disputeFacts: [dispute(R1, false)] })).toBe('waiting');
  });

  it('disputed outranks promised — the dispute pause wins precedence (first match)', () => {
    const c = caseAt('in_progress', [R1]);
    expect(
      deriveCaseStatus(c, {
        promiseFacts: [promise(R1, 'pending')],
        disputeFacts: [dispute(R1, true)],
      }),
    ).toBe('disputed');
    // even when the promise and the dispute sit on different covered receivables
    const two = caseAt('in_progress', [R1, R2]);
    expect(
      deriveCaseStatus(two, {
        promiseFacts: [promise(R1, 'pending')],
        disputeFacts: [dispute(R2, true)],
      }),
    ).toBe('disputed');
  });

  it('facts about NON-covered receivables are ignored (they belong to another case)', () => {
    const c = caseAt('in_progress', [R1]);
    expect(
      deriveCaseStatus(c, {
        promiseFacts: [promise(R99, 'pending')],
        disputeFacts: [dispute(R99, true)],
      }),
    ).toBe('waiting');
  });

  it('terminal cases return their stored status — child facts stop mattering at closure', () => {
    for (const status of ['resolved', 'closed_inactive'] as const) {
      const c = caseAt(status);
      expect(
        deriveCaseStatus(c, {
          promiseFacts: [promise(R1, 'pending')],
          disputeFacts: [dispute(R1, true)],
        }),
      ).toBe(status);
    }
  });

  it('the overlay applies to BOTH live stored statuses', () => {
    for (const status of ['open', 'in_progress'] as const) {
      expect(deriveCaseStatus(caseAt(status), { promiseFacts: [promise(R1, 'pending')] })).toBe('promised');
      expect(deriveCaseStatus(caseAt(status), { disputeFacts: [dispute(R1, true)] })).toBe('disputed');
    }
  });

  it('malformed child facts carry stable codes (plain-data contract is validated)', () => {
    const c = caseAt('open');
    expect(() =>
      deriveCaseStatus(c, { promiseFacts: [{ receivableId: R1, status: 'hopeful' as PromiseFact['status'] }] }),
    ).toThrowError(DomainError);
    try {
      deriveCaseStatus(c, { promiseFacts: [{ receivableId: R1, status: 'hopeful' as PromiseFact['status'] }] });
    } catch (err) {
      expect((err as DomainError).code).toBe('CASE_PROMISE_STATUS_INVALID');
    }
    expect(() =>
      deriveCaseStatus(c, { disputeFacts: [{ receivableId: R1, open: 'yes' as unknown as boolean }] }),
    ).toThrowError(DomainError);
    try {
      deriveCaseStatus(c, { disputeFacts: [{ receivableId: R1, open: 'yes' as unknown as boolean }] });
    } catch (err) {
      expect((err as DomainError).code).toBe('CASE_DISPUTE_FACT_INVALID');
    }
  });
});

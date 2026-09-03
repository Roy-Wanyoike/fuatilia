/**
 * Derived case status — the WAITING / PROMISED / DISPUTED overlay
 * (issue #8, docs/03 CollectionsCase SM's PromisePending/Escalated lanes).
 *
 * The stored lifecycle is deliberately minimal (`open → in_progress →
 * resolved | closed_inactive`): whether a case is "waiting", "waiting on a
 * promise" or "paused by a dispute" is a PROJECTION of child facts, never a
 * stored state. Storing it would let the stored status drift from the child
 * lanes' truth; deriving it keeps one source of truth and makes the whole
 * matrix table-testable from plain data.
 *
 * `deriveCaseStatus(case, childFacts)` is pure and takes PLAIN DATA only —
 * the promises and disputes lanes are referenced by opaque receivable ids,
 * never imported. Facts about receivables the case does not cover are
 * ignored (they belong to some other case).
 *
 * Decision matrix (first match wins, documented so callers can rely on it):
 *
 *   1. stored `resolved` | `closed_inactive` → returned as-is. Terminal
 *      cases are history; child facts stop mattering the instant the case
 *      closes.
 *   2. any OPEN dispute on a covered receivable → `disputed`. SPEC §29: a
 *      disputed invoice must not blindly continue aggressive collection
 *      automation, so the dispute pause outranks everything live.
 *   3. any PENDING promise on a covered receivable → `promised`. Only a
 *      pending promise keeps the promise state: `fulfilled` ends it (the
 *      receivable was paid) and `broken` ends it too — a broken promise is
 *      NOT a promise anymore, the case falls back to `waiting` and the
 *      d11 response is an escalation step (see `escalateCase`), not a
 *      stored status.
 *   4. otherwise → `waiting` (the default live state: nothing owed to
 *      promise-tracking or dispute-pause right now).
 */
import { DomainError, type Uuid } from '../shared';
import type { CaseStatus, CollectionsCase } from './case';

export const PROMISE_STATUSES = ['pending', 'fulfilled', 'broken'] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];

/** Plain-data promise fact, projected by the adapter from the promises lane. */
export interface PromiseFact {
  readonly receivableId: Uuid;
  readonly status: PromiseStatus;
}

/** Plain-data dispute fact, projected by the adapter from the disputes lane. */
export interface DisputeFact {
  readonly receivableId: Uuid;
  readonly open: boolean;
}

export interface CaseChildFacts {
  readonly promiseFacts?: readonly PromiseFact[];
  readonly disputeFacts?: readonly DisputeFact[];
}

/** Stored statuses + the three derived overlays, for exhaustive UI maps. */
export const DERIVED_CASE_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'closed_inactive',
  'waiting',
  'promised',
  'disputed',
] as const;
export type DerivedCaseStatus = CaseStatus | 'waiting' | 'promised' | 'disputed';

const assertPromiseFacts = (facts: readonly PromiseFact[]): readonly PromiseFact[] =>
  facts.map((f) => {
    if (!(PROMISE_STATUSES as readonly string[]).includes(f.status)) {
      throw new DomainError('CASE_PROMISE_STATUS_INVALID', `unknown promise status: ${String(f.status)}`, {
        receivableId: f.receivableId,
        status: String(f.status),
        allowed: PROMISE_STATUSES,
      });
    }
    return f;
  });

const assertDisputeFacts = (facts: readonly DisputeFact[]): readonly DisputeFact[] =>
  facts.map((f) => {
    if (typeof f.open !== 'boolean') {
      throw new DomainError('CASE_DISPUTE_FACT_INVALID', 'a dispute fact requires a boolean open flag', {
        receivableId: f.receivableId,
        open: f.open,
      });
    }
    return f;
  });

/**
 * Compute the derived status of `collectionsCase` from plain child facts —
 * see the module doc for the exact matrix. Never throws for valid facts;
 * throws only on malformed fact input (stable codes
 * CASE_PROMISE_STATUS_INVALID / CASE_DISPUTE_FACT_INVALID).
 */
export function deriveCaseStatus(
  collectionsCase: CollectionsCase,
  facts: CaseChildFacts = {},
): DerivedCaseStatus {
  const stored = collectionsCase.status;
  if (stored === 'resolved' || stored === 'closed_inactive') {
    return stored; // rule 1 — terminal cases are history
  }

  const covered = new Set<Uuid>(collectionsCase.receivableIds);
  const disputeFacts = assertDisputeFacts(facts.disputeFacts ?? []);
  const promiseFacts = assertPromiseFacts(facts.promiseFacts ?? []);

  // rule 2 — an open dispute on any covered receivable pauses the case
  if (disputeFacts.some((f) => f.open && covered.has(f.receivableId))) {
    return 'disputed';
  }

  // rule 3 — a pending promise on any covered receivable holds the case
  if (promiseFacts.some((f) => f.status === 'pending' && covered.has(f.receivableId))) {
    return 'promised';
  }

  // rule 4 — live with nothing holding: waiting for the next scheduled action
  return 'waiting';
}

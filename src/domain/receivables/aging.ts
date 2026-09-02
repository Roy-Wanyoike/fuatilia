/**
 * Aging buckets (docs/02-domain-model.md, receivables lane README):
 *   '0-30' | '31-60' | '61-90' | '90+' — whole days past the due date.
 *
 * Pure derivation from the injected Clock. Only meaningful while the debt is
 * live: a settled receivable has nothing left to age, so we refuse instead of
 * pretending (AGING_NOT_APPLICABLE). Terminal-but-decided states (written_off,
 * uncollectible, recovered, voided, draft) still compute — reporting needs
 * their history.
 */
import { DomainError, type Clock } from '../shared';
import type { Receivable } from './receivable';

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

const DAY_MS = 86_400_000;

/**
 * Whole days past the due date, floored (a partial late day is not yet a full
 * day late) and clamped at 0 — current receivables are never negative.
 */
export function daysPastDue(receivable: Receivable, clock: Clock): number {
  const elapsedMs = clock.now().getTime() - receivable.dueDate.getTime();
  return Math.max(0, Math.floor(elapsedMs / DAY_MS));
}

/**
 * Aging bucket for a receivable at `clock.now()`.
 * Boundary semantics: day 30 → '0-30', day 31 → '31-60', day 60 → '31-60',
 * day 61 → '61-90', day 90 → '61-90', day 91 → '90+'.
 */
export function agingBucket(receivable: Receivable, clock: Clock): AgingBucket {
  if (receivable.state === 'settled') {
    throw new DomainError(
      'AGING_NOT_APPLICABLE',
      `receivable ${receivable.id} is settled — nothing left to age`,
    );
  }
  const days = daysPastDue(receivable, clock);
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

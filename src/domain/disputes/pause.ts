/**
 * Collections pause policy — the pure, plain-data heart of SPEC §29's rule:
 * "A disputed invoice should not blindly continue aggressive collection
 * automation." (issue #20)
 *
 * The contract with the collections lanes is deliberately DUMB DATA:
 *
 *   - `OPEN_DISPUTE_STATES` / `isDisputeOpen` — which dispute states count as
 *     live (re-exported from the aggregate; the lifecycle owner decides);
 *   - `collectionsHoldFor(disputeStates)` — given the dispute states recorded
 *     against ONE receivable, is automated collections on hold for it? Any
 *     live state ⇒ true;
 *   - `automatedCollectionAllowed(disputeFacts)` — the policy gate over typed
 *     facts: any open dispute on the receivable ⇒ false. Collections lanes
 *     assemble the facts for the receivable they are about to dun (a plain
 *     filter over a projection — no aggregate, no transition logic imports);
 *   - `toDisputeFacts(dispute)` — projects a full aggregate down to the
 *     pause-relevant facts row.
 *
 * Pause ⇒ resume is a property of the dispute lifecycle, not of this module:
 * the pause fact is `dispute.opened` and the resume facts are
 * `dispute.resolved` / `dispute.rejected` / `dispute.cancelled` — once the
 * dispute reaches a terminal state it drops out of OPEN_DISPUTE_STATES and
 * the same pure functions flip, with no hidden state anywhere (this module
 * holds none — every function is total over its inputs).
 */
import type { Uuid } from '../shared';
import { isDisputeOpen, type Dispute, type DisputeStatus } from './dispute';

export { OPEN_DISPUTE_STATES, isDisputeOpen } from './dispute';

/**
 * The collections-facing projection of a dispute: enough plain data to
 * evaluate the pause policy, nothing that couples the consumer to the
 * aggregate.
 */
export interface DisputeFacts {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  readonly status: DisputeStatus;
}

/** Project a dispute aggregate down to its pause-policy facts row. */
export const toDisputeFacts = (dispute: Dispute): DisputeFacts => ({
  disputeId: dispute.id,
  receivableId: dispute.receivableId,
  status: dispute.status,
});

/**
 * Is automated collections ON HOLD for this receivable?
 *
 * `disputeStates` are the dispute states currently recorded against the one
 * receivable being evaluated (its receivable dispute states, plain strings
 * from a projection). Any live dispute state ⇒ hold.
 */
export const collectionsHoldFor = (disputeStates: readonly DisputeStatus[]): boolean =>
  disputeStates.some(isDisputeOpen);

/**
 * The policy gate collections automation must pass before dunning: given the
 * dispute facts recorded for the receivable you are about to dun, is
 * automated collection allowed? ANY open dispute on the receivable ⇒ false.
 *
 * Pure and total: empty facts ⇒ allowed; no hidden state, no I/O.
 */
export const automatedCollectionAllowed = (disputeFacts: readonly DisputeFacts[]): boolean =>
  !disputeFacts.some((fact) => isDisputeOpen(fact.status));

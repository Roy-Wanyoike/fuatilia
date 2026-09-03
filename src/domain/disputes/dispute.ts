/**
 * Dispute — the customer's challenge to a receivable (issue #20, SPEC §29,
 * review diagram d14_sm_dispute).
 *
 * Lifecycle (docs/03 states, d14 edges + return paths so no state is a
 * dead end — see DISPUTE_TRANSITIONS):
 *
 *   opened → investigating → awaiting_customer | awaiting_business
 *   opened → cancelled                    (withdrawn before investigation)
 *   investigating → resolved | rejected | cancelled
 *   awaiting_customer | awaiting_business → investigating (work resumes)
 *                                          → resolved | rejected | cancelled
 *   resolved | rejected | cancelled → terminal, nothing re-opens them.
 *
 * SPEC §29: "A disputed invoice should not blindly continue aggressive
 * collection automation." Opening a dispute therefore emits the typed PAUSE
 * fact (`dispute.opened`) and every terminal transition emits a RESUME fact
 * (`dispute.resolved` / `.rejected` / `.cancelled`); the pure policy consumed
 * by collections lanes lives in ./pause.ts.
 *
 * Invariants honored here:
 *   - at most ONE open dispute per receivable (mirrors R8 exclusivity for
 *     collections cases) — a second openDispute on the same receivable
 *     throws DISPUTE_ALREADY_OPEN;
 *   - disputeNumber is a per-org controlled sequence: the caller supplies
 *     the next sequence number (the per-org counter lives with the adapter),
 *     the lane validates shape, monotonicity and uniqueness within the org;
 *   - every transition records reason + actor — the aggregate carries an
 *     append-only history log (R3 discipline); nothing is ever mutated in
 *     place, each operation returns a fresh immutable copy.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock, cross-lane ids (receivable, credit note, write-off) passed
 * in as opaque Uuids. Illegal transitions throw DomainError with stable
 * SCREAMING_SNAKE codes.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  domainEvent,
  type DisputeCancelledPayload,
  type DisputeEvent,
  type DisputeOpenedPayload,
  type DisputeRejectedPayload,
  type DisputeResolvedPayload,
  type DisputeStatusChangedPayload,
} from './events';

// --- categories (SPEC §29 "Dispute Category") --------------------------------

export const DISPUTE_CATEGORIES = [
  'pricing',
  'quality',
  'quantity',
  'delivery',
  'duplicate',
  'other',
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const assertCategory = (category: string): DisputeCategory => {
  if (!(DISPUTE_CATEGORIES as readonly string[]).includes(category)) {
    throw new DomainError('DISPUTE_CATEGORY_INVALID', `unknown dispute category: ${category}`, {
      category,
      allowed: DISPUTE_CATEGORIES,
    });
  }
  return category as DisputeCategory;
};

// --- lifecycle states (docs/03: Opened … Cancelled) ---------------------------

export type DisputeStatus =
  | 'opened'
  | 'investigating'
  | 'awaiting_customer'
  | 'awaiting_business'
  | 'resolved'
  | 'rejected'
  | 'cancelled';

const DISPUTE_STATUSES: readonly DisputeStatus[] = [
  'opened',
  'investigating',
  'awaiting_customer',
  'awaiting_business',
  'resolved',
  'rejected',
  'cancelled',
];

/**
 * The states from which a dispute is still LIVE — exactly the states that
 * hold automated collections (see ./pause.ts, which re-exports this set as
 * the pause policy's data basis).
 */
export const OPEN_DISPUTE_STATES: readonly DisputeStatus[] = [
  'opened',
  'investigating',
  'awaiting_customer',
  'awaiting_business',
];

/** A dispute is open iff its state still allows transitions (terminal ⇒ closed). */
export const isDisputeOpen = (status: DisputeStatus): boolean =>
  (OPEN_DISPUTE_STATES as readonly string[]).includes(status);

/**
 * The legal-transition table, in one place so docs/03 and the code cannot
 * drift. Rows are `from`, entries are the legal `to` states:
 *
 *   opened            → investigating | cancelled
 *   investigating     → awaiting_customer | awaiting_business
 *                     | resolved | rejected | cancelled
 *   awaiting_customer → investigating | resolved | rejected | cancelled
 *   awaiting_business → investigating | resolved | rejected | cancelled
 *   resolved / rejected / cancelled → terminal (empty rows).
 *
 * Deliberately NOT legal: skipping `investigating` on the way to an outcome
 * from `opened` (a claim must at least be picked up), hopping
 * awaiting_customer ↔ awaiting_business without returning to investigating
 * (the record must show who unblocked the wait), any transition out of a
 * terminal state (re-opening rewrites history — open a new dispute instead,
 * which is legal once the previous one is closed).
 */
export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  opened: ['investigating', 'cancelled'],
  investigating: ['awaiting_customer', 'awaiting_business', 'resolved', 'rejected', 'cancelled'],
  awaiting_customer: ['investigating', 'resolved', 'rejected', 'cancelled'],
  awaiting_business: ['investigating', 'resolved', 'rejected', 'cancelled'],
  resolved: [],
  rejected: [],
  cancelled: [],
};

// --- outcome decision (resolution remedy) -------------------------------------

/**
 * What the business decided when it resolved the dispute: the reason lives in
 * the transition; the remedy is one of — nothing (claim upheld, no adjustment
 * needed), a credit note against the receivable, or an approved write-off.
 * Credit notes and write-offs are OTHER lanes' aggregates: referenced by
 * opaque Uuid, never imported.
 */
export type DisputeOutcome =
  | { readonly remedy: 'none' }
  | { readonly remedy: 'credit_note'; readonly creditNoteId: Uuid }
  | { readonly remedy: 'write_off'; readonly writeOffId: Uuid };

export const NO_REMEDY: DisputeOutcome = { remedy: 'none' };

const assertOutcome = (outcome: DisputeOutcome | undefined): DisputeOutcome => {
  if (outcome === undefined) return NO_REMEDY;
  switch (outcome.remedy) {
    case 'none':
      return NO_REMEDY;
    case 'credit_note':
      if (outcome.creditNoteId === undefined || outcome.creditNoteId === null) {
        throw new DomainError(
          'DISPUTE_OUTCOME_INVALID',
          'a credit_note remedy requires an opaque creditNoteId',
          { outcome },
        );
      }
      return outcome;
    case 'write_off':
      if (outcome.writeOffId === undefined || outcome.writeOffId === null) {
        throw new DomainError(
          'DISPUTE_OUTCOME_INVALID',
          'a write_off remedy requires an opaque writeOffId',
          { outcome },
        );
      }
      return outcome;
    default:
      throw new DomainError('DISPUTE_OUTCOME_INVALID', `unknown dispute remedy`, { outcome });
  }
};

// --- the aggregate -------------------------------------------------------------

/** One appended audit row: every transition records why, who and when. */
export interface DisputeTransition {
  readonly from: DisputeStatus;
  readonly to: DisputeStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly at: Date;
}

export interface Dispute {
  readonly id: Uuid;
  /** Per-org controlled sequence, formatted at open (e.g. `DSP-000014`). */
  readonly disputeNumber: string;
  /** 1-based sequence position within the owning org (audit + ordering). */
  readonly sequence: number;
  readonly orgId: Uuid;
  /** The challenged debt position — opaque Uuid, owned by the receivables lane. */
  readonly receivableId: Uuid;
  readonly category: DisputeCategory;
  readonly description: string;
  /** Opaque evidence references (documents, photos, message ids). */
  readonly evidenceRefs: readonly string[];
  /** Opaque assigned-user id; null until someone picks it up. */
  readonly assignedTo: Uuid | null;
  readonly openedAt: Date;
  readonly openedBy: string;
  readonly status: DisputeStatus;
  /** Set only on `resolved`. */
  readonly outcome: DisputeOutcome | null;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  /** Append-only audit trail — transitions are appended, never rewritten. */
  readonly history: readonly DisputeTransition[];
}

// --- input validation (stable codes) --------------------------------------------

const assertClockDate = (at: Date, code: string): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'clock returned an invalid Date');
  }
  return at;
};

const assertNonBlank = (raw: string, code: string, label: string): string => {
  const value = raw.trim();
  if (value.length === 0) {
    throw new DomainError(code, `a dispute requires a non-blank ${label}`);
  }
  return value;
};

const assertActor = (actorId: string): string =>
  assertNonBlank(actorId, 'DISPUTE_ACTOR_REQUIRED', 'actor id (every transition has an owner)');

// --- opening ---------------------------------------------------------------------

/** Default disputeNumber shape: org-agnostic `DSP-` + 6-digit zero-padded sequence. */
export const formatDisputeNumber = (sequenceNo: number): string =>
  `DSP-${String(sequenceNo).padStart(6, '0')}`;

export interface OpenDisputeArgs {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly category: string;
  readonly description: string;
  readonly evidenceRefs?: readonly string[];
  readonly assignedTo?: Uuid | null;
  /** Actor who opened the dispute (audit). */
  readonly openedBy: string;
  /** Next position in the org's controlled dispute sequence (safe integer ≥ 1). */
  readonly sequenceNo: number;
  /** Injectable pure number formatter; defaults to formatDisputeNumber. */
  readonly formatNumber?: (sequenceNo: number) => string;
}

/**
 * Open a dispute against a receivable — emits the PAUSE fact
 * (`dispute.opened`). The per-org sequence counter lives with the caller
 * (adapter); the lane validates it: safe integer ≥ 1, strictly greater than
 * every sequence already used by the org, unique formatted number within the
 * org.
 *
 * Throws:
 *   - DISPUTE_CATEGORY_INVALID / DISPUTE_DESCRIPTION_REQUIRED /
 *     DISPUTE_ACTOR_REQUIRED / DISPUTE_EVIDENCE_INVALID — malformed request;
 *   - DISPUTE_CLOCK_INVALID — broken injected clock;
 *   - DISPUTE_SEQUENCE_INVALID — sequenceNo not a safe integer ≥ 1;
 *   - DISPUTE_SEQUENCE_OUT_OF_ORDER — sequenceNo not newer than the org's
 *     latest used sequence;
 *   - DISPUTE_NUMBER_INVALID — the formatter returned a blank number;
 *   - DISPUTE_NUMBER_TAKEN — the formatted number already exists in the org;
 *   - DISPUTE_ID_TAKEN — the dispute id already exists in the registry
 *     (protects the audit trail from id collisions);
 *   - DISPUTE_ALREADY_OPEN — the receivable already carries an open dispute
 *     (the one-dispute-at-a-time exclusivity rule).
 */
export function openDispute(
  args: OpenDisputeArgs,
  existingDisputes: readonly Dispute[],
  clock: Clock,
): { dispute: Dispute; event: DisputeEvent & { readonly name: 'dispute.opened' } } {
  const category = assertCategory(args.category);
  const description = assertNonBlank(
    args.description,
    'DISPUTE_DESCRIPTION_REQUIRED',
    'description of the challenge',
  );
  const openedBy = assertActor(args.openedBy);
  const openedAt = assertClockDate(clock.now(), 'DISPUTE_CLOCK_INVALID');

  if (!Number.isSafeInteger(args.sequenceNo) || args.sequenceNo < 1) {
    throw new DomainError(
      'DISPUTE_SEQUENCE_INVALID',
      `sequenceNo must be a safe integer ≥ 1, got ${args.sequenceNo}`,
      { sequenceNo: args.sequenceNo },
    );
  }

  const inOrg = existingDisputes.filter((d) => d.orgId === args.orgId);

  const latestSequence = inOrg.reduce((max, d) => Math.max(max, d.sequence), 0);
  if (args.sequenceNo <= latestSequence) {
    throw new DomainError(
      'DISPUTE_SEQUENCE_OUT_OF_ORDER',
      `sequenceNo ${args.sequenceNo} is not newer than the latest used sequence ${latestSequence} for this org`,
      { sequenceNo: args.sequenceNo, latestSequence },
    );
  }

  const format = args.formatNumber ?? formatDisputeNumber;
  const disputeNumber = assertNonBlank(
    format(args.sequenceNo),
    'DISPUTE_NUMBER_INVALID',
    'disputeNumber (the formatter returned a blank value)',
  );
  if (inOrg.some((d) => d.disputeNumber === disputeNumber)) {
    throw new DomainError(
      'DISPUTE_NUMBER_TAKEN',
      `disputeNumber ${disputeNumber} is already used in this org`,
      { disputeNumber, orgId: args.orgId },
    );
  }

  if (existingDisputes.some((d) => d.id === args.id)) {
    throw new DomainError('DISPUTE_ID_TAKEN', `dispute id already registered: ${args.id}`, {
      id: args.id,
    });
  }

  const openOnReceivable = existingDisputes.find(
    (d) => d.receivableId === args.receivableId && isDisputeOpen(d.status),
  );
  if (openOnReceivable) {
    throw new DomainError(
      'DISPUTE_ALREADY_OPEN',
      `receivable ${args.receivableId} already has an open dispute ${openOnReceivable.disputeNumber} (${openOnReceivable.status}) — resolve it first`,
      {
        receivableId: args.receivableId,
        disputeId: openOnReceivable.id,
        status: openOnReceivable.status,
      },
    );
  }

  const evidenceRefs = (args.evidenceRefs ?? []).map((ref) =>
    assertNonBlank(ref, 'DISPUTE_EVIDENCE_INVALID', 'evidence reference (blank reference given)'),
  );

  const dispute: Dispute = {
    id: args.id,
    disputeNumber,
    sequence: args.sequenceNo,
    orgId: args.orgId,
    receivableId: args.receivableId,
    category,
    description,
    evidenceRefs,
    assignedTo: args.assignedTo ?? null,
    openedAt,
    openedBy,
    status: 'opened',
    outcome: null,
    closedAt: null,
    closedBy: null,
    history: [],
  };

  const event = domainEvent<'dispute.opened', DisputeOpenedPayload>(
    'dispute.opened',
    dispute.id,
    {
      disputeId: dispute.id,
      disputeNumber,
      orgId: dispute.orgId,
      receivableId: dispute.receivableId,
      category,
      description,
      evidenceRefs,
      assignedTo: dispute.assignedTo,
      openedBy,
      openedAt: openedAt.toISOString(),
    },
    clock,
  );
  return { dispute, event };
}

// --- transitioning ----------------------------------------------------------------

export interface TransitionDisputeArgs {
  readonly reason: string;
  readonly actorId: string;
  /** Required only when transitioning to `resolved`; defaults to no remedy. */
  readonly outcome?: DisputeOutcome;
}

/**
 * Move a dispute one step along its lifecycle. The transition must be in
 * DISPUTE_TRANSITIONS (else DISPUTE_TRANSITION_INVALID with `{from, to}`),
 * and every step carries a reason + actorId — the pair is appended to the
 * aggregate's history log, so the trail is audit-complete by construction.
 *
 * Event contract:
 *   - non-terminal steps emit `dispute.statusChanged` (from → to);
 *   - `resolved` emits `dispute.resolved` with the outcome decision,
 *     `rejected` emits `dispute.rejected`, `cancelled` emits
 *     `dispute.cancelled` — the RESUME facts that lift the collections hold.
 */
export function transitionDispute(
  dispute: Dispute,
  to: DisputeStatus,
  args: TransitionDisputeArgs,
  clock: Clock,
): { dispute: Dispute; event: DisputeEvent } {
  if (!DISPUTE_STATUSES.includes(to)) {
    throw new DomainError('DISPUTE_STATUS_INVALID', `unknown dispute status: ${String(to)}`, {
      to: String(to),
      allowed: DISPUTE_STATUSES,
    });
  }
  const from = dispute.status;
  if (!DISPUTE_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'DISPUTE_TRANSITION_INVALID',
      `cannot move a dispute from ${from} to ${to}`,
      { from, to },
    );
  }
  const reason = assertNonBlank(
    args.reason,
    'DISPUTE_REASON_REQUIRED',
    'reason (every transition is a recorded decision)',
  );
  const actorId = assertActor(args.actorId);
  const at = assertClockDate(clock.now(), 'DISPUTE_CLOCK_INVALID');

  const terminal = DISPUTE_TRANSITIONS[to].length === 0;
  const outcome = to === 'resolved' ? assertOutcome(args.outcome) : null;

  const history = dispute.history;
  const next: Dispute = {
    ...dispute,
    status: to,
    outcome: to === 'resolved' ? outcome : dispute.outcome,
    closedAt: terminal ? at : dispute.closedAt,
    closedBy: terminal ? actorId : dispute.closedBy,
    history: [...history, { from, to, reason, actorId, at }],
  };

  let event: DisputeEvent;
  if (to === 'resolved') {
    event = domainEvent<'dispute.resolved', DisputeResolvedPayload>(
      'dispute.resolved',
      dispute.id,
      {
        disputeId: dispute.id,
        receivableId: dispute.receivableId,
        reason,
        actorId,
        outcome: outcome as DisputeOutcome,
        resolvedAt: at.toISOString(),
      },
      clock,
    );
  } else if (to === 'rejected') {
    event = domainEvent<'dispute.rejected', DisputeRejectedPayload>(
      'dispute.rejected',
      dispute.id,
      {
        disputeId: dispute.id,
        receivableId: dispute.receivableId,
        reason,
        actorId,
        rejectedAt: at.toISOString(),
      },
      clock,
    );
  } else if (to === 'cancelled') {
    event = domainEvent<'dispute.cancelled', DisputeCancelledPayload>(
      'dispute.cancelled',
      dispute.id,
      {
        disputeId: dispute.id,
        receivableId: dispute.receivableId,
        reason,
        actorId,
        cancelledAt: at.toISOString(),
      },
      clock,
    );
  } else {
    event = domainEvent<'dispute.statusChanged', DisputeStatusChangedPayload>(
      'dispute.statusChanged',
      dispute.id,
      { disputeId: dispute.id, receivableId: dispute.receivableId, from, to, reason, actorId },
      clock,
    );
  }
  return { dispute: next, event };
}

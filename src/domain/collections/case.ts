/**
 * CollectionsCase — the work unit that drives dunning on one or more
 * receivables (issue #8, review finding H6, docs/03 CollectionsCase SM).
 *
 * Stored lifecycle (docs/03; WAITING/PROMISED/DISPUTED are NEVER stored —
 * they are derived views computed in ./derive.ts):
 *
 *   open → in_progress                  an agent/scheduled step engaged
 *   in_progress → resolved              outcome reached (settled, verdict…)
 *   in_progress → closed_inactive       parked/closed without an outcome
 *   resolved | closed_inactive          terminal — nothing re-opens them;
 *                                       open a NEW case instead (legal once
 *                                       the old one is closed — R8 release).
 *
 * Invariants honored here:
 *
 *   - **R8 case exclusivity (core invariant):** at most one OPEN case may
 *     cover a receivable at any instant. `openCase` receives the existing
 *     open-case coverage as PLAIN DATA — `openCaseCoverage:
 *     {receivableId, caseId}[]` — and rejects any new case whose receivables
 *     intersect it with a stable `CASE_ALREADY_OPEN` error. A multi-receivable
 *     case covers ALL of its receivables: covering A+B blocks new cases on A
 *     and on B. Closing releases the receivables (see `openCaseCoverageOf` +
 *     `transitionCase`'s `case.closed` payload).
 *   - caseNumber is a per-org controlled sequence: the caller supplies the
 *     next sequence number and may inject the formatter (default
 *     `CASE-000001`); the per-org counter lives with the adapter.
 *   - Append-only logs (R3 discipline): `actions` (see ./actions.ts) and
 *     `history`/`priorityChanges` are only ever grown; nothing is mutated in
 *     place — every operation returns a fresh immutable copy.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock. Cross-lane ids (receivable, collector) are opaque Uuids.
 * Illegal inputs/transitions throw DomainError with stable SCREAMING_SNAKE
 * codes (`CASE_*`).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { CaseAction } from './actions';
import {
  domainEvent,
  type CaseClosedPayload,
  type CaseEscalatedPayload,
  type CaseOpenedPayload,
  type CaseResolvedPayload,
  type CollectionsEvent,
} from './events';

// --- priorities ---------------------------------------------------------------

export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/** Higher number = more urgent; escalation may only climb this ladder. */
export const CASE_PRIORITY_RANK: Readonly<Record<CasePriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export const assertPriority = (priority: string): CasePriority => {
  if (!(CASE_PRIORITIES as readonly string[]).includes(priority)) {
    throw new DomainError('CASE_PRIORITY_INVALID', `unknown case priority: ${priority}`, {
      priority,
      allowed: CASE_PRIORITIES,
    });
  }
  return priority as CasePriority;
};

// --- stored lifecycle states (issue #8) ----------------------------------------

export type CaseStatus = 'open' | 'in_progress' | 'resolved' | 'closed_inactive';

const CASE_STATUSES: readonly CaseStatus[] = ['open', 'in_progress', 'resolved', 'closed_inactive'];

/**
 * The statuses from which a case still holds R8 coverage over its
 * receivables. Terminal statuses (resolved / closed_inactive) release them.
 */
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = ['open', 'in_progress'];

/** A case is open iff it still holds R8 coverage (terminal ⇒ released). */
export const isCaseOpen = (status: CaseStatus): boolean =>
  (OPEN_CASE_STATUSES as readonly string[]).includes(status);

/**
 * The legal-transition table, in one place so docs/03 and the code cannot
 * drift. Rows are `from`, entries are the legal `to` states:
 *
 *   open            → in_progress
 *   in_progress     → resolved | closed_inactive
 *   resolved        → terminal (empty row)
 *   closed_inactive → terminal (empty row)
 *
 * Deliberately NOT legal: skipping engagement (`open → resolved` — an
 * outcome requires someone to have worked the case), re-opening a closed
 * case (rewrites history — open a new case instead, which becomes legal
 * because the closed case no longer holds R8 coverage), and any hop out of
 * a terminal state.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  open: ['in_progress'],
  in_progress: ['resolved', 'closed_inactive'],
  resolved: [],
  closed_inactive: [],
};

// --- the aggregate ---------------------------------------------------------------

/** One appended audit row: every lifecycle transition records why, who, when. */
export interface CaseTransitionRecord {
  readonly from: CaseStatus;
  readonly to: CaseStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly at: Date;
}

/** One appended audit row per priority bump (see escalateCase). */
export interface CasePriorityChangeRecord {
  readonly from: CasePriority;
  readonly to: CasePriority;
  readonly reason: string;
  readonly actorId: string;
  readonly at: Date;
}

export interface CollectionsCase {
  readonly id: Uuid;
  /** Per-org controlled sequence, formatted at open (e.g. `CASE-000007`). */
  readonly caseNumber: string;
  /** 1-based sequence position within the owning org (audit + ordering). */
  readonly sequence: number;
  readonly orgId: Uuid;
  /** Opaque receivable ids this case covers — R8 locks ALL of them while open. */
  readonly receivableIds: readonly Uuid[];
  /** Opaque collector (user/team) id, owned by an adapter lane. */
  readonly collectorId: Uuid;
  readonly priority: CasePriority;
  readonly status: CaseStatus;
  readonly openedAt: Date;
  readonly openedBy: string;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  /** Append-only action log — see ./actions.ts (recordAction/completeAction). */
  readonly actions: readonly CaseAction[];
  /** Append-only lifecycle audit trail. */
  readonly history: readonly CaseTransitionRecord[];
  /** Append-only priority-bump audit trail. */
  readonly priorityChanges: readonly CasePriorityChangeRecord[];
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
    throw new DomainError(code, `a collections case requires a non-blank ${label}`);
  }
  return value;
};

const assertActor = (actorId: string): string =>
  assertNonBlank(actorId, 'CASE_ACTOR_REQUIRED', 'actor id (every step has an owner)');

// --- R8 coverage (plain data — the exclusivity guard's only input) ---------------

/**
 * One open-case coverage fact, exactly as the issue-#8 guard contract
 * specifies: which receivable is covered by which (open) case. Adapters
 * project this from their case store; the lane never dereferences `caseId`.
 */
export interface OpenCaseCoverage {
  readonly receivableId: Uuid;
  readonly caseId: Uuid;
}

/**
 * Project plain open-case coverage from case aggregates: every receivable of
 * every still-open case contributes one entry. Closing a case therefore
 * releases its receivables — feed the result of this function to the next
 * `openCase` call and R8 follows mechanically.
 */
export function openCaseCoverageOf(
  cases: readonly Pick<CollectionsCase, 'id' | 'status' | 'receivableIds'>[],
): OpenCaseCoverage[] {
  return cases
    .filter((c) => isCaseOpen(c.status))
    .flatMap((c) => c.receivableIds.map((receivableId) => ({ receivableId, caseId: c.id })));
}

// --- opening ---------------------------------------------------------------------

/** Default caseNumber shape: org-agnostic `CASE-` + 6-digit zero-padded sequence. */
export const formatCaseNumber = (sequenceNo: number): string =>
  `CASE-${String(sequenceNo).padStart(6, '0')}`;

export interface OpenCaseArgs {
  readonly id: Uuid;
  readonly orgId: Uuid;
  /** ≥ 1 opaque receivable id(s) this case covers — R8 locks all of them. */
  readonly receivableIds: readonly Uuid[];
  readonly collectorId: Uuid;
  /** Defaults to 'normal' when omitted. */
  readonly priority?: string;
  readonly openedBy: string;
  /** Next position in the org's controlled case sequence (safe integer ≥ 1). */
  readonly sequenceNo: number;
  /** Injectable pure number formatter; defaults to formatCaseNumber. */
  readonly formatNumber?: (sequenceNo: number) => string;
}

/**
 * Open a CollectionsCase — emits `case.opened`, the R8 exclusivity fact.
 *
 * R8 guard (core invariant): `openCaseCoverage` is the plain-data list of
 * receivables already covered by an open case. If ANY of the new case's
 * receivables appears in it, opening is rejected with CASE_ALREADY_OPEN and
 * the details name the conflicting `{receivableId, caseId}` pair (first
 * conflict in `args.receivableIds` order wins, deterministically). A
 * multi-receivable case covers A+B, so it blocks new cases on A and on B.
 *
 * Throws:
 *   - CASE_RECEIVABLES_REQUIRED / CASE_RECEIVABLE_INVALID /
 *     CASE_RECEIVABLE_DUPLICATE — malformed receivable list;
 *   - CASE_COLLECTOR_REQUIRED / CASE_ACTOR_REQUIRED — missing owner/actor;
 *   - CASE_PRIORITY_INVALID — unknown priority string;
 *   - CASE_SEQUENCE_INVALID — sequenceNo not a safe integer ≥ 1;
 *   - CASE_NUMBER_INVALID — the formatter returned a blank number;
 *   - CASE_CLOCK_INVALID — broken injected clock;
 *   - CASE_ALREADY_OPEN — R8: a receivable is already covered by an open case.
 */
export function openCase(
  args: OpenCaseArgs,
  openCaseCoverage: readonly OpenCaseCoverage[],
  clock: Clock,
): { case: CollectionsCase; events: readonly [CollectionsEvent & { name: 'case.opened' }] } {
  const openedAt = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');
  const openedBy = assertActor(args.openedBy);
  // assertNonBlank trims (widening the brand away) — restore the opaque Uuid brand after the check.
  const collectorId = assertNonBlank(
    args.collectorId,
    'CASE_COLLECTOR_REQUIRED',
    'collector id (every case has an owner)',
  ) as Uuid;

  const receivableIds = args.receivableIds ?? [];
  if (receivableIds.length === 0) {
    throw new DomainError(
      'CASE_RECEIVABLES_REQUIRED',
      'a collections case must cover at least one receivable (R8 is defined per receivable)',
    );
  }
  for (const receivableId of receivableIds) {
    if (typeof receivableId !== 'string' || receivableId.trim().length === 0) {
      throw new DomainError(
        'CASE_RECEIVABLE_INVALID',
        'receivable ids must be non-blank opaque ids',
        { receivableId: String(receivableId) },
      );
    }
  }
  const duplicate = receivableIds.find(
    (id, i) => receivableIds.findIndex((other) => other === id) !== i,
  );
  if (duplicate !== undefined) {
    throw new DomainError(
      'CASE_RECEIVABLE_DUPLICATE',
      `receivable ${duplicate} appears more than once in the same case`,
      { receivableId: duplicate },
    );
  }

  const priority = args.priority === undefined ? 'normal' : assertPriority(args.priority);

  if (!Number.isSafeInteger(args.sequenceNo) || args.sequenceNo < 1) {
    throw new DomainError(
      'CASE_SEQUENCE_INVALID',
      `sequenceNo must be a safe integer ≥ 1, got ${String(args.sequenceNo)}`,
      { sequenceNo: args.sequenceNo },
    );
  }
  const format = args.formatNumber ?? formatCaseNumber;
  const caseNumber = assertNonBlank(
    format(args.sequenceNo),
    'CASE_NUMBER_INVALID',
    'caseNumber (the formatter returned a blank value)',
  );

  // --- R8 exclusivity guard (first conflict in receivableIds order wins) ---
  for (const receivableId of receivableIds) {
    const covering = openCaseCoverage.find((entry) => entry.receivableId === receivableId);
    if (covering !== undefined) {
      throw new DomainError(
        'CASE_ALREADY_OPEN',
        `receivable ${receivableId} is already covered by open case ${covering.caseId} — close that case first (R8: at most one open case per receivable)`,
        { receivableId, caseId: covering.caseId },
      );
    }
  }

  const collectionsCase: CollectionsCase = {
    id: args.id,
    caseNumber,
    sequence: args.sequenceNo,
    orgId: args.orgId,
    receivableIds: [...receivableIds],
    collectorId,
    priority,
    status: 'open',
    openedAt,
    openedBy,
    closedAt: null,
    closedBy: null,
    actions: [],
    history: [],
    priorityChanges: [],
  };

  const event = domainEvent<'case.opened', CaseOpenedPayload>(
    'case.opened',
    collectionsCase.id,
    {
      caseId: collectionsCase.id,
      caseNumber,
      orgId: collectionsCase.orgId,
      receivableIds: collectionsCase.receivableIds,
      collectorId,
      priority,
      openedBy,
      openedAt: openedAt.toISOString(),
    },
    clock,
  );
  return { case: collectionsCase, events: [event] };
}

// --- transitioning ----------------------------------------------------------------

export interface TransitionCaseArgs {
  readonly reason: string;
  readonly actorId: string;
}

/**
 * Move a case one step along its lifecycle. The transition must be in
 * CASE_TRANSITIONS (else CASE_TRANSITION_INVALID with `{from, to}`), and
 * every step carries a reason + actorId — appended to the aggregate's
 * history log, so the trail is audit-complete by construction.
 *
 * Event contract (issue #8 catalog — there is deliberately no
 * `case.statusChanged`): engaging (`open → in_progress`) emits no lane event,
 * the engagement is visible through the recorded actions and the history
 * log; `resolved` emits `case.resolved`; `closed_inactive` emits `case.closed`
 * whose `releasedReceivableIds` mark the instant those receivables stop being
 * R8-covered.
 */
export function transitionCase(
  collectionsCase: CollectionsCase,
  to: CaseStatus,
  args: TransitionCaseArgs,
  clock: Clock,
): { case: CollectionsCase; events: readonly CollectionsEvent[] } {
  if (!(CASE_STATUSES as readonly string[]).includes(to)) {
    throw new DomainError('CASE_STATUS_INVALID', `unknown case status: ${String(to)}`, {
      to: String(to),
      allowed: CASE_STATUSES,
    });
  }
  const from = collectionsCase.status;
  if (!CASE_TRANSITIONS[from].includes(to)) {
    throw new DomainError('CASE_TRANSITION_INVALID', `cannot move a case from ${from} to ${to}`, {
      from,
      to,
    });
  }
  const reason = assertNonBlank(
    args.reason,
    'CASE_REASON_REQUIRED',
    'reason (every transition is a recorded decision)',
  );
  const actorId = assertActor(args.actorId);
  const at = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');

  const terminal = CASE_TRANSITIONS[to].length === 0;
  const next: CollectionsCase = {
    ...collectionsCase,
    status: to,
    closedAt: terminal ? at : collectionsCase.closedAt,
    closedBy: terminal ? actorId : collectionsCase.closedBy,
    history: [...collectionsCase.history, { from, to, reason, actorId, at }],
  };

  let events: readonly CollectionsEvent[];
  if (to === 'resolved') {
    const event = domainEvent<'case.resolved', CaseResolvedPayload>(
      'case.resolved',
      collectionsCase.id,
      {
        caseId: collectionsCase.id,
        caseNumber: collectionsCase.caseNumber,
        orgId: collectionsCase.orgId,
        receivableIds: collectionsCase.receivableIds,
        reason,
        actorId,
        resolvedAt: at.toISOString(),
      },
      clock,
    );
    events = [event];
  } else if (to === 'closed_inactive') {
    const event = domainEvent<'case.closed', CaseClosedPayload>(
      'case.closed',
      collectionsCase.id,
      {
        caseId: collectionsCase.id,
        caseNumber: collectionsCase.caseNumber,
        orgId: collectionsCase.orgId,
        releasedReceivableIds: collectionsCase.receivableIds,
        reason,
        actorId,
        closedAt: at.toISOString(),
      },
      clock,
    );
    events = [event];
  } else {
    events = [];
  }
  return { case: next, events };
}

// --- escalating -------------------------------------------------------------------

export interface EscalateCaseArgs {
  /** The new priority — must rank strictly ABOVE the current one. */
  readonly to: string;
  readonly reason: string;
  readonly actorId: string;
}

/**
 * Raise a case's priority (low → normal → high → urgent) with a recorded
 * reason — emits `case.escalated` and appends to the priorityChanges log.
 *
 * Throws:
 *   - CASE_CLOSED — the case is no longer open (nothing to escalate);
 *   - CASE_PRIORITY_INVALID — unknown target priority;
 *   - CASE_ESCALATION_INVALID — target does not rank strictly above the
 *     current priority (escalation climbs, it never sidesteps or downgrades —
 *     deliberate de-escalation is a lane-adapter policy decision, recorded
 *     there, not silently on the aggregate);
 *   - CASE_REASON_REQUIRED / CASE_ACTOR_REQUIRED / CASE_CLOCK_INVALID.
 */
export function escalateCase(
  collectionsCase: CollectionsCase,
  args: EscalateCaseArgs,
  clock: Clock,
): { case: CollectionsCase; events: readonly [CollectionsEvent & { name: 'case.escalated' }] } {
  if (!isCaseOpen(collectionsCase.status)) {
    throw new DomainError(
      'CASE_CLOSED',
      `case ${collectionsCase.caseNumber} is ${collectionsCase.status} — nothing to escalate`,
      { caseId: collectionsCase.id, status: collectionsCase.status },
    );
  }
  const to = assertPriority(args.to);
  const from = collectionsCase.priority;
  if (CASE_PRIORITY_RANK[to] <= CASE_PRIORITY_RANK[from]) {
    throw new DomainError(
      'CASE_ESCALATION_INVALID',
      `escalation must strictly raise the priority; ${from} → ${to} does not`,
      { from, to },
    );
  }
  const reason = assertNonBlank(
    args.reason,
    'CASE_REASON_REQUIRED',
    'reason (every escalation is a recorded decision)',
  );
  const actorId = assertActor(args.actorId);
  const at = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');

  const next: CollectionsCase = {
    ...collectionsCase,
    priority: to,
    priorityChanges: [
      ...collectionsCase.priorityChanges,
      { from, to, reason, actorId, at },
    ],
  };

  const event = domainEvent<'case.escalated', CaseEscalatedPayload>(
    'case.escalated',
    collectionsCase.id,
    {
      caseId: collectionsCase.id,
      caseNumber: collectionsCase.caseNumber,
      orgId: collectionsCase.orgId,
      from,
      to,
      reason,
      actorId,
      escalatedAt: at.toISOString(),
    },
    clock,
  );
  return { case: next, events: [event] };
}

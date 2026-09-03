/**
 * Case actions — the append-only dunning activity log on a CollectionsCase
 * (issue #8, review finding H6 + K2 consent hook).
 *
 * Actions are the case's work record: calls, sms, whatsapp sends, letters,
 * field visits and escalation steps. The log is append-only (R3 discipline):
 * `recordAction` only ever APPENDS a frozen entry and `completeAction` only
 * ever stamps `outcome` + `completedAt` + `completedBy` on a fresh copy —
 * entries are never removed, reordered or edited in place, and the input
 * aggregate object is never mutated.
 *
 * K2 dunning-consent hook (Kenya DPA 2019 / Meta policy, docs/07 K2):
 * automated outbound dunning sends (`sms`, `whatsapp`) REQUIRE an opaque
 * `consentRef` — the reference to the customer's active dunning consent
 * grant (consent lane, referenced by id only). An automated send without one
 * is rejected with the stable `DUNNING_CONSENT_REQUIRED` code and NOT
 * appended; the compliance record of the blocked attempt is the
 * `collections.dunningBlockedNoConsent` event (see ./events.ts), returned as
 * a value by `tryRecordAction` so adapters can emit it exactly when they
 * surface the rejection. Source semantics (fail-closed):
 *
 *   - `sms` | `whatsapp` default to `source: 'automated'` — forgetting the
 *     flag never bypasses the consent gate;
 *   - `source: 'manual'` sends need no consentRef (a human chose to send);
 *   - `call` | `letter` | `fieldVisit` | `escalation` are never gated.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock. Illegal inputs throw DomainError with stable
 * SCREAMING_SNAKE codes.
 */
import { DomainError, type Clock } from '../shared';
import { isCaseOpen, type CollectionsCase } from './case';
import {
  domainEvent,
  type CaseActionRecordedPayload,
  type CollectionsEvent,
  type DunningBlockedNoConsentPayload,
} from './events';

// --- action taxonomy -----------------------------------------------------------

export const CASE_ACTION_TYPES = [
  'call',
  'sms',
  'whatsapp',
  'letter',
  'fieldVisit',
  'escalation',
] as const;
export type CaseActionType = (typeof CASE_ACTION_TYPES)[number];

/** Outbound dunning sends — the ONLY action types the K2 consent gate covers. */
export const OUTBOUND_ACTION_TYPES: readonly CaseActionType[] = ['sms', 'whatsapp'];

export type ActionSource = 'automated' | 'manual';

const ACTION_SOURCES: readonly ActionSource[] = ['automated', 'manual'];

export interface CaseAction {
  readonly id: string;
  readonly type: CaseActionType;
  /** When the action is scheduled to happen (validated, may be in the past — backfills). */
  readonly scheduledFor: Date;
  /** Non-null once the action completed; stamped by completeAction (or at record time for backfills). */
  readonly outcome: string | null;
  readonly completedAt: Date | null;
  /** Who recorded the completion; null until then. */
  readonly completedBy: string | null;
  /** Opaque dunning consent reference; null unless supplied (required for automated outbound sends). */
  readonly consentRef: string | null;
  readonly source: ActionSource;
  /** Who recorded the action (audit). */
  readonly actorId: string;
  readonly recordedAt: Date;
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
    throw new DomainError(code, `a case action requires a non-blank ${label}`);
  }
  return value;
};

export const assertActionType = (type: string): CaseActionType => {
  if (!(CASE_ACTION_TYPES as readonly string[]).includes(type)) {
    throw new DomainError('CASE_ACTION_TYPE_INVALID', `unknown case action type: ${type}`, {
      type,
      allowed: CASE_ACTION_TYPES,
    });
  }
  return type as CaseActionType;
};

const assertSource = (source: string): ActionSource => {
  if (!(ACTION_SOURCES as readonly string[]).includes(source)) {
    throw new DomainError('CASE_ACTION_SOURCE_INVALID', `unknown action source: ${source}`, {
      source,
      allowed: ACTION_SOURCES,
    });
  }
  return source as ActionSource;
};

// --- recording -------------------------------------------------------------------

export interface RecordActionArgs {
  /** Overrides are rarely needed — defaults to `<caseId>/actions/<n>` (log is append-only, so n is stable). */
  readonly id?: string;
  readonly type: string;
  readonly scheduledFor: Date;
  /** Supply when the action already happened (backfill): the entry is logged completed. */
  readonly outcome?: string;
  readonly actorId: string;
  /**
   * 'automated' | 'manual'. Outbound dunning types (sms/whatsapp) DEFAULT to
   * 'automated' — fail-closed so a forgotten flag can never bypass consent.
   * All other types default to 'manual'.
   */
  readonly source?: string;
  /** Opaque reference to the customer's active dunning consent grant (K2). */
  readonly consentRef?: string | null;
}

/**
 * Append an action to the case's log — emits `case.actionRecorded`.
 *
 * Throws:
 *   - CASE_CLOSED — the case is resolved/closed_inactive (no activity on
 *     terminal cases; the log is sealed at closure);
 *   - CASE_ACTION_TYPE_INVALID / CASE_ACTION_SOURCE_INVALID /
 *     CASE_ACTION_ID_REQUIRED — malformed request;
 *   - CASE_SCHEDULED_FOR_INVALID — scheduledFor not a valid Date;
 *   - CASE_CLOCK_INVALID — broken injected clock;
 *   - CASE_ACTOR_REQUIRED — missing actor;
 *   - CASE_OUTCOME_REQUIRED — an explicitly given outcome was blank;
 *   - DUNNING_CONSENT_REQUIRED — K2: an automated `sms`/`whatsapp` send
 *     without a non-blank consentRef. The action is NOT appended; use
 *     `tryRecordAction` to obtain the `collections.dunningBlockedNoConsent`
 *     compliance event alongside this rejection.
 */
export function recordAction(
  collectionsCase: CollectionsCase,
  args: RecordActionArgs,
  clock: Clock,
): { case: CollectionsCase; events: readonly [CollectionsEvent & { name: 'case.actionRecorded' }] } {
  if (!isCaseOpen(collectionsCase.status)) {
    throw new DomainError(
      'CASE_CLOSED',
      `case ${collectionsCase.caseNumber} is ${collectionsCase.status} — its action log is sealed`,
      { caseId: collectionsCase.id, status: collectionsCase.status },
    );
  }
  const type = assertActionType(args.type);
  const scheduledFor = assertClockDate(args.scheduledFor, 'CASE_SCHEDULED_FOR_INVALID');

  // K2 default: outbound dunning sends are assumed automated unless a human
  // is explicitly on the hook — forgetting the flag must not bypass consent.
  const source = args.source === undefined
    ? (OUTBOUND_ACTION_TYPES as readonly string[]).includes(type)
      ? 'automated'
      : 'manual'
    : assertSource(args.source);

  const recordedAt = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');
  const actorId = assertNonBlank(args.actorId, 'CASE_ACTOR_REQUIRED', 'actor id');

  const consentRef = args.consentRef === undefined || args.consentRef === null
    ? null
    : assertNonBlank(args.consentRef, 'CASE_CONSENT_REF_INVALID', 'consent reference');

  if (
    (OUTBOUND_ACTION_TYPES as readonly string[]).includes(type) &&
    source === 'automated' &&
    consentRef === null
  ) {
    throw new DomainError(
      'DUNNING_CONSENT_REQUIRED',
      `automated ${type} dunning on case ${collectionsCase.caseNumber} requires an active dunning consent reference (K2) — nothing was sent`,
      {
        caseId: collectionsCase.id,
        actionType: type,
        source,
      },
    );
  }

  const outcome =
    args.outcome === undefined
      ? null
      : assertNonBlank(args.outcome, 'CASE_OUTCOME_REQUIRED', 'outcome (blank when completing)');
  const completedAt = outcome === null ? null : recordedAt;

  const actionId =
    args.id === undefined
      ? `${collectionsCase.id}/actions/${collectionsCase.actions.length + 1}`
      : assertNonBlank(args.id, 'CASE_ACTION_ID_REQUIRED', 'action id');

  const action: CaseAction = {
    id: actionId,
    type,
    scheduledFor,
    outcome,
    completedAt,
    completedBy: outcome === null ? null : actorId,
    consentRef,
    source,
    actorId,
    recordedAt,
  };

  const next: CollectionsCase = {
    ...collectionsCase,
    actions: [...collectionsCase.actions, action],
  };

  const event = domainEvent<'case.actionRecorded', CaseActionRecordedPayload>(
    'case.actionRecorded',
    collectionsCase.id,
    {
      caseId: collectionsCase.id,
      caseNumber: collectionsCase.caseNumber,
      orgId: collectionsCase.orgId,
      actionId,
      actionType: type,
      scheduledFor: scheduledFor.toISOString(),
      outcome,
      completedAt: completedAt === null ? null : completedAt.toISOString(),
      consentRef,
      actorId,
      recordedAt: recordedAt.toISOString(),
    },
    clock,
  );
  return { case: next, events: [event] };
}

// --- completing --------------------------------------------------------------------

export interface CompleteActionArgs {
  /** What happened — required, non-blank (the outcome IS the completion). */
  readonly outcome: string;
  /** Defaults to the action's recording actor when omitted. */
  readonly actorId?: string;
}

/**
 * Stamp an existing log entry as completed: sets `outcome`, `completedAt`
 * (from the Clock) and `completedBy` on a fresh copy of the entry. The log
 * stays append-only — no entry is removed or rewritten, and completing an
 * already-completed entry is refused.
 *
 * Emits no lane event: the issue-#8 catalog has no `case.actionCompleted`;
 * the completion is visible on the aggregate's sealed-by-closure log.
 *
 * Throws:
 *   - CASE_CLOSED — the case is terminal;
 *   - CASE_ACTION_NOT_FOUND — no log entry with that id;
 *   - CASE_ACTION_ALREADY_COMPLETED — the entry already carries an outcome
 *     (including entries backfilled as completed at record time);
 *   - CASE_OUTCOME_REQUIRED — blank/missing outcome;
 *   - CASE_ACTOR_REQUIRED — an explicitly given actorId was blank;
 *   - CASE_CLOCK_INVALID — broken injected clock.
 */
export function completeAction(
  collectionsCase: CollectionsCase,
  actionId: string,
  args: CompleteActionArgs,
  clock: Clock,
): { case: CollectionsCase; events: readonly CollectionsEvent[] } {
  if (!isCaseOpen(collectionsCase.status)) {
    throw new DomainError(
      'CASE_CLOSED',
      `case ${collectionsCase.caseNumber} is ${collectionsCase.status} — its action log is sealed`,
      { caseId: collectionsCase.id, status: collectionsCase.status },
    );
  }
  const target = collectionsCase.actions.find((a) => a.id === actionId);
  if (target === undefined) {
    throw new DomainError(
      'CASE_ACTION_NOT_FOUND',
      `case ${collectionsCase.caseNumber} has no action ${actionId}`,
      { actionId, caseId: collectionsCase.id },
    );
  }
  if (target.completedAt !== null) {
    throw new DomainError(
      'CASE_ACTION_ALREADY_COMPLETED',
      `action ${actionId} was already completed at ${target.completedAt.toISOString()}`,
      { actionId, completedAt: target.completedAt.toISOString() },
    );
  }
  const outcome = assertNonBlank(args.outcome, 'CASE_OUTCOME_REQUIRED', 'outcome');
  const completedAt = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');
  const completedBy =
    args.actorId === undefined
      ? target.actorId
      : assertNonBlank(args.actorId, 'CASE_ACTOR_REQUIRED', 'actor id');

  const actions = collectionsCase.actions.map((a) =>
    a.id === actionId ? { ...a, outcome, completedAt, completedBy } : a,
  );
  const next: CollectionsCase = { ...collectionsCase, actions };
  return { case: next, events: [] };
}

// --- K2 refusal-as-value wrapper ------------------------------------------------------

export type RecordActionResult =
  | { readonly ok: true; readonly case: CollectionsCase; readonly events: readonly CollectionsEvent[] }
  | {
      readonly ok: false;
      /** The stable rejection — always code DUNNING_CONSENT_REQUIRED. */
      readonly error: DomainError;
      /** The K2 compliance event for the blocked attempt — emit it on refusal. */
      readonly blockedEvent: CollectionsEvent & { name: 'collections.dunningBlockedNoConsent' };
    };

/**
 * Pure factory for the `collections.dunningBlockedNoConsent` K2 refusal fact
 * (exported so adapters that catch `DUNNING_CONSENT_REQUIRED` from
 * `recordAction` directly can still build the compliance event).
 */
export function dunningBlockedNoConsentEvent(
  collectionsCase: CollectionsCase,
  args: Pick<RecordActionArgs, 'type' | 'scheduledFor' | 'actorId'>,
  reason: string,
  clock: Clock,
): CollectionsEvent & { name: 'collections.dunningBlockedNoConsent' } {
  const blockedAt = assertClockDate(clock.now(), 'CASE_CLOCK_INVALID');
  return domainEvent<'collections.dunningBlockedNoConsent', DunningBlockedNoConsentPayload>(
    'collections.dunningBlockedNoConsent',
    collectionsCase.id,
    {
      caseId: collectionsCase.id,
      caseNumber: collectionsCase.caseNumber,
      orgId: collectionsCase.orgId,
      receivableIds: collectionsCase.receivableIds,
      actionType: assertActionType(args.type),
      scheduledFor: args.scheduledFor.toISOString(),
      actorId: args.actorId,
      reason,
      blockedAt: blockedAt.toISOString(),
    },
    clock,
  );
}

/**
 * `recordAction` with the K2 refusal surfaced as a VALUE (the consent lane's
 * "refusal is a valid outcome" pattern): on the happy path returns
 * `{ok: true, case, events}`; when the automated outbound send is blocked it
 * returns `{ok: false, error, blockedEvent}` — the rejection
 * (`DUNNING_CONSENT_REQUIRED`) AND the `collections.dunningBlockedNoConsent`
 * compliance event, ready to emit. ALL other DomainErrors rethrow unchanged
 * (malformed input is a bug, not a refusal).
 */
export function tryRecordAction(
  collectionsCase: CollectionsCase,
  args: RecordActionArgs,
  clock: Clock,
): RecordActionResult {
  try {
    const result = recordAction(collectionsCase, args, clock);
    return { ok: true, case: result.case, events: result.events };
  } catch (err) {
    if (err instanceof DomainError && err.code === 'DUNNING_CONSENT_REQUIRED') {
      const blockedEvent = dunningBlockedNoConsentEvent(
        collectionsCase,
        { type: args.type, scheduledFor: args.scheduledFor, actorId: args.actorId },
        err.message,
        clock,
      );
      return { ok: false, error: err, blockedEvent };
    }
    throw err;
  }
}


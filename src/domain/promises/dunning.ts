/**
 * Dunning orchestration — the pure SPEC §18 cadence engine (issue #19).
 *
 * The ladder is CONFIGURATION, not code: a list of steps, each with a day
 * offset relative to the due date (negative = pre-due), a message kind, a
 * channel and a `requiresConsent` flag. SPEC §18's example ladder is shipped
 * as DEFAULT_DUNNING_LADDER and "make this configurable / do not hard-code
 * these rules" is honored by letting callers pass their own ladder.
 *
 *   3 days before due  → friendly reminder          (email)
 *   due date           → payment request            (email)
 *   3 days overdue     → WhatsApp                   (consent-gated, K2)
 *   7 days overdue     → SMS
 *   14 days overdue    → collector task             (internal)
 *   30 days overdue    → manager escalation         (internal)
 *   45 days overdue    → payment-plan offer         (email)
 *   60+ days overdue   → recovery workflow          (internal)
 *
 * Consent (K2 — Kenya DPA 2019 / Meta policy): a step flagged
 * requiresConsent may only be sent when the subject carries a consentRef.
 * The orchestrator refuses such sends and emits the typed refusal fact
 * `collections.dunningBlockedNoConsent`; callers who want exception-style
 * refusal use assertDunningSendable, which throws the stable code
 * DUNNING_CONSENT_REQUIRED. Consent is never implied — a missing or blank
 * consentRef blocks, every time.
 *
 * Escalation: when a step was sent and the customer has not responded N days
 * (facts-driven, configured per subject), escalationDue fires and
 * dunningEscalatedEvent produces `dunning.escalated` with the wait evidence.
 *
 * Everything is pure and deterministic: day arithmetic is UTC-day-index
 * based, so day boundaries land at midnight UTC regardless of wall-clock
 * time; `now` is passed in (from the caller's injected Clock) — no
 * Date.now(), no I/O, no RNG. Data-in/data-out: facts are plain objects;
 * cross-lane ids travel as opaque Uuids.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  domainEvent,
  type CollectionsDunningBlockedNoConsentPayload,
  type DunningEscalatedPayload,
  type DunningStepDuePayload,
  type DunningEvent,
} from './events';

// --- ladder config (SPEC §18) ---------------------------------------------------

export const DUNNING_CHANNELS = ['email', 'sms', 'whatsapp', 'task'] as const;
export type DunningChannel = (typeof DUNNING_CHANNELS)[number];

export const DUNNING_STEP_KINDS = [
  'reminder',
  'payment_request',
  'whatsapp',
  'sms',
  'collector_task',
  'manager_escalation',
  'payment_plan_offer',
  'recovery_workflow',
] as const;
export type DunningStepKind = (typeof DUNNING_STEP_KINDS)[number];

export interface DunningStep {
  /** Stable step key — the idempotence handle for sentSteps (e.g. `overdue_day_3`). */
  readonly key: string;
  /** Days relative to the due date (negative = pre-due, 0 = on the due date). */
  readonly dayOffset: number;
  readonly kind: DunningStepKind;
  readonly channel: DunningChannel;
  /**
   * K2 gate: when true, the send is refused unless the subject carries a
   * consentRef (DUNNING_CONSENT_REQUIRED). Never implied, never inherited.
   */
  readonly requiresConsent: boolean;
}

const step = (
  key: string,
  dayOffset: number,
  kind: DunningStepKind,
  channel: DunningChannel,
  requiresConsent: boolean,
): DunningStep => ({ key, dayOffset, kind, channel, requiresConsent });

/**
 * SPEC §18's example cadence, as configuration. WhatsApp touches are
 * consent-gated (K2/Meta policy); email reminders and SMS notices about an
 * existing debt are transactional and are not; internal task steps never
 * contact the customer.
 */
export const DEFAULT_DUNNING_LADDER: readonly DunningStep[] = [
  step('pre_due_reminder', -3, 'reminder', 'email', false),
  step('due_date_request', 0, 'payment_request', 'email', false),
  step('overdue_day_3', 3, 'whatsapp', 'whatsapp', true),
  step('overdue_day_7', 7, 'sms', 'sms', false),
  step('overdue_day_14', 14, 'collector_task', 'task', false),
  step('overdue_day_30', 30, 'manager_escalation', 'task', false),
  step('overdue_day_45', 45, 'payment_plan_offer', 'email', false),
  step('overdue_day_60', 60, 'recovery_workflow', 'task', false),
];

/**
 * Validate a ladder: non-empty, unique keys, integer offsets, sorted by
 * offset (deterministic due-order). Throws DUNNING_LADDER_INVALID.
 */
export function assertLadder(ladder: readonly DunningStep[]): readonly DunningStep[] {
  if (ladder.length === 0) {
    throw new DomainError('DUNNING_LADDER_INVALID', 'a dunning ladder needs at least one step');
  }
  const keys = new Set<string>();
  let previousOffset = -Infinity;
  for (const s of ladder) {
    if (typeof s.key !== 'string' || s.key.trim().length === 0) {
      throw new DomainError('DUNNING_LADDER_INVALID', `every step needs a non-blank key`, {
        step: s,
      });
    }
    if (keys.has(s.key)) {
      throw new DomainError('DUNNING_LADDER_INVALID', `duplicate step key: ${s.key}`, {
        key: s.key,
      });
    }
    keys.add(s.key);
    if (!Number.isSafeInteger(s.dayOffset)) {
      throw new DomainError(
        'DUNNING_LADDER_INVALID',
        `step ${s.key} dayOffset must be a safe integer, got ${String(s.dayOffset)}`,
        { key: s.key, dayOffset: s.dayOffset },
      );
    }
    if (s.dayOffset < previousOffset) {
      throw new DomainError(
        'DUNNING_LADDER_INVALID',
        `ladder must be sorted by dayOffset (${s.key} at ${s.dayOffset} after ${previousOffset})`,
        { key: s.key, dayOffset: s.dayOffset },
      );
    }
    previousOffset = s.dayOffset;
  }
  return ladder;
}

// --- facts (plain data in, plain data out) -----------------------------------------

export interface DunningFacts {
  /** The ladder anchor — the receivable's due date (or promised date). */
  readonly dueDate: Date;
  /** Step keys already sent (idempotence: a step never fires twice). */
  readonly sentSteps: readonly string[];
  /** Opaque consent-grant reference; null/undefined blocks consent-gated steps. */
  readonly consentRef?: string | null;
  /** Opaque dunning subject (receivable or case id) for event payloads. */
  readonly subjectId: Uuid;
  readonly orgId: Uuid;
}

// --- day arithmetic (UTC day-index — deterministic day boundaries) --------------------

/** Whole UTC days between two instants (floor of the calendar-day distance). */
export const utcDaysBetween = (from: Date, to: Date): number => {
  const dayIndex = (d: Date): number =>
    Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
  return dayIndex(to) - dayIndex(from);
};

const assertDate = (value: Date, code: string, label: string): Date => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError(code, `${label} is not a valid Date`);
  }
  return value;
};

// --- step selection -------------------------------------------------------------------

/**
 * Which ladder steps are due as of `now`? A step is due when the subject is
 * at least `dayOffset` UTC days past (or before, for negative offsets) the
 * due date AND the step has not been sent yet (sentSteps is the idempotence
 * set). Steps come back in ladder order, so callers can work through a
 * backlog oldest-first. Pure: `now` comes from the caller's injected Clock.
 *
 * Selection is deliberately consent-blind — the orchestrator splits due
 * steps into sends and refusals (K2) so blocked steps stay observable.
 */
export function dueSteps(
  now: Date,
  facts: DunningFacts,
  ladder: readonly DunningStep[] = DEFAULT_DUNNING_LADDER,
): readonly DunningStep[] {
  assertDate(now, 'DUNNING_CLOCK_INVALID', 'now');
  assertDate(facts.dueDate, 'DUNNING_FACTS_INVALID', 'dueDate');
  const steps = assertLadder(ladder);
  const daysPast = utcDaysBetween(facts.dueDate, now);
  const sent = new Set(facts.sentSteps);
  return steps.filter((s) => !sent.has(s.key) && daysPast >= s.dayOffset);
}

// --- the consent gate (K2) ------------------------------------------------------------

export type DunningSendRefusalReason = 'DUNNING_CONSENT_REQUIRED';

export type DunningSendDecision =
  | { readonly allowed: true; readonly step: DunningStep }
  | {
      readonly allowed: false;
      readonly reason: DunningSendRefusalReason;
      readonly detail: string;
    };

/**
 * May this step be sent for a subject carrying `consentRef`?
 *
 * Decision-style gate: a refusal is a VALUE (typed reason
 * DUNNING_CONSENT_REQUIRED), never an exception — invalid *input* is what
 * throws. A blank/whitespace consentRef counts as absent: consent is never
 * implied (K2).
 */
export function evaluateDunningSend(
  step: DunningStep,
  consentRef: string | null | undefined,
): DunningSendDecision {
  if (!step.requiresConsent) {
    return { allowed: true, step };
  }
  if (typeof consentRef === 'string' && consentRef.trim().length > 0) {
    return { allowed: true, step };
  }
  return {
    allowed: false,
    reason: 'DUNNING_CONSENT_REQUIRED',
    detail: `dunning step ${step.key} (${step.channel}) requires consent but the subject carries no consentRef`,
  };
}

/**
 * Exception-style K2 gate: throws DomainError with the stable code
 * DUNNING_CONSENT_REQUIRED when a consent-gated step has no consentRef.
 * Adapters catch it and persist the paired `collections.dunningBlockedNoConsent`
 * fact (see orchestrateDunning, which does both halves in one pass).
 */
export function assertDunningSendable(
  step: DunningStep,
  consentRef: string | null | undefined,
): void {
  const decision = evaluateDunningSend(step, consentRef);
  if (!decision.allowed) {
    throw new DomainError(decision.reason, decision.detail, {
      stepKey: step.key,
      channel: step.channel,
    });
  }
}

// --- the orchestrator ------------------------------------------------------------------

export interface DunningSend {
  readonly step: DunningStep;
  readonly event: DunningEvent & { readonly name: 'dunning.stepDue' };
}

export interface DunningBlocked {
  readonly step: DunningStep;
  /** Stable code DUNNING_CONSENT_REQUIRED — machine-mappable by adapters. */
  readonly reason: DunningSendRefusalReason;
  readonly event: DunningEvent & { readonly name: 'collections.dunningBlockedNoConsent' };
}

export interface DunningPlan {
  /** Steps that may be sent now, ladder order, each with its dunning.stepDue event. */
  readonly sends: readonly DunningSend[];
  /** Consent-gated steps refused for lack of a consentRef, with the typed refusal fact. */
  readonly blocked: readonly DunningBlocked[];
}

/**
 * Orchestrate one dunning tick for a subject (pure — a scheduled job calls
 * this with `now` from its injected clock, then persists/dispatches the
 * returned events):
 *
 *   1. select the due steps (dueSteps: ladder + sentSteps idempotence);
 *   2. split them through the K2 consent gate — allowed steps become sends
 *      carrying `dunning.stepDue`; refused steps become blocked entries
 *      carrying the stable code DUNNING_CONSENT_REQUIRED and the
 *      `collections.dunningBlockedNoConsent` event, so the refusal is an
 *      observable fact, not a silent drop.
 *
 * The SAME tick never both blocks and proceeds silently: every due step
 * lands in exactly one of sends/blocked (the invariant the tests pin).
 */
export function orchestrateDunning(
  now: Date,
  facts: DunningFacts,
  clock: Clock,
  ladder: readonly DunningStep[] = DEFAULT_DUNNING_LADDER,
): DunningPlan {
  const due = dueSteps(now, facts, ladder);
  const consentRef = facts.consentRef ?? null;
  const sends: DunningSend[] = [];
  const blocked: DunningBlocked[] = [];

  for (const s of due) {
    const decision = evaluateDunningSend(s, consentRef);
    const base: DunningStepDuePayload = {
      orgId: facts.orgId,
      subjectId: facts.subjectId,
      stepKey: s.key,
      dayOffset: s.dayOffset,
      kind: s.kind,
      channel: s.channel,
      requiresConsent: s.requiresConsent,
      dueDate: facts.dueDate.toISOString(),
    };
    if (decision.allowed) {
      sends.push({ step: s, event: domainEvent<'dunning.stepDue', DunningStepDuePayload>('dunning.stepDue', facts.subjectId, base, clock) });
    } else {
      const payload: CollectionsDunningBlockedNoConsentPayload = {
        orgId: facts.orgId,
        subjectId: facts.subjectId,
        stepKey: s.key,
        channel: s.channel,
        blockedAt: clock.now().toISOString(),
      };
      blocked.push({
        step: s,
        reason: decision.reason,
        event: domainEvent<'collections.dunningBlockedNoConsent', CollectionsDunningBlockedNoConsentPayload>(
          'collections.dunningBlockedNoConsent',
          facts.subjectId,
          payload,
          clock,
        ),
      });
    }
  }
  return { sends, blocked };
}

// --- escalation (facts-driven, deterministic) --------------------------------------------

/** Default no-response window before a sent step escalates. */
export const DEFAULT_ESCALATION_AFTER_DAYS = 3;

export interface DunningEscalationFacts {
  /** When the step was last sent; null when nothing was ever sent. */
  readonly lastSendAt: Date | null;
  /** When the customer last responded; a response predating the last send counts as none. */
  readonly lastResponseAt: Date | null;
  /** The step that went unanswered. */
  readonly stepKey: string;
  readonly channel: string;
  readonly subjectId: Uuid;
  readonly orgId: Uuid;
  /** No-response window in whole days (configurable per subject/policy). */
  readonly escalationAfterDays?: number;
}

/**
 * Has the no-response escalation horizon passed? True iff a step was sent,
 * the customer has not responded since that send, and at least
 * `escalationAfterDays` whole UTC days (default DEFAULT_ESCALATION_AFTER_DAYS)
 * have elapsed. Deterministic for a given (now, facts) pair — the fake-clock
 * tests pin the day boundary.
 */
export function escalationDue(now: Date, facts: DunningEscalationFacts): boolean {
  assertDate(now, 'DUNNING_CLOCK_INVALID', 'now');
  const afterDays = facts.escalationAfterDays ?? DEFAULT_ESCALATION_AFTER_DAYS;
  if (!Number.isSafeInteger(afterDays) || afterDays < 0) {
    throw new DomainError(
      'DUNNING_ESCALATION_INVALID',
      `escalationAfterDays must be a safe integer ≥ 0, got ${String(afterDays)}`,
      { escalationAfterDays: afterDays },
    );
  }
  if (facts.lastSendAt === null) {
    return false; // nothing sent — nothing to escalate
  }
  assertDate(facts.lastSendAt, 'DUNNING_FACTS_INVALID', 'lastSendAt');
  if (facts.lastResponseAt !== null) {
    assertDate(facts.lastResponseAt, 'DUNNING_FACTS_INVALID', 'lastResponseAt');
    if (facts.lastResponseAt.getTime() >= facts.lastSendAt.getTime()) {
      return false; // responded since the send — no escalation
    }
  }
  return utcDaysBetween(facts.lastSendAt, now) >= afterDays;
}

/**
 * The escalation event: `dunning.escalated` carries the wait evidence (which
 * step, which channel, how many whole days) so collections/intelligence can
 * act without importing this lane. Throws DUNNING_ESCALATION_NOT_DUE when
 * escalationDue does not hold — callers check first, this double-checks.
 */
export function dunningEscalatedEvent(
  now: Date,
  facts: DunningEscalationFacts,
  clock: Clock,
): DunningEvent & { readonly name: 'dunning.escalated' } {
  if (!escalationDue(now, facts)) {
    throw new DomainError(
      'DUNNING_ESCALATION_NOT_DUE',
      `no-response escalation for ${facts.stepKey} is not due yet`,
    );
  }
  const waitedDays = utcDaysBetween(facts.lastSendAt as Date, now);
  const payload: DunningEscalatedPayload = {
    orgId: facts.orgId,
    subjectId: facts.subjectId,
    stepKey: facts.stepKey,
    channel: facts.channel,
    lastSendAt: (facts.lastSendAt as Date).toISOString(),
    waitedDays,
    escalatedAt: clock.now().toISOString(),
  };
  return domainEvent<'dunning.escalated', DunningEscalatedPayload>(
    'dunning.escalated',
    facts.subjectId,
    payload,
    clock,
  );
}

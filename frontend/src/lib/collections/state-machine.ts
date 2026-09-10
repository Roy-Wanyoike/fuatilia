import type {
  CaseActionSource,
  CaseActionType,
  CasePriority,
  CaseStatus,
  CaseView,
} from '@/lib/api/wire-types';

/**
 * The collections CASE STATE MACHINE + ACTION LADDER, mirrored from the
 * contract and the domain lane so the UI can only ever offer moves the
 * wire accepts:
 *
 *  - transition edges: api/openapi/fuatilia.v1.yaml → POST …/transitions
 *    description ("open → in_progress, in_progress → resolved |
 *    closed_inactive; terminal statuses take no edges", spec lines
 *    1272–1278) — identical to src/domain/collections/case.ts
 *    `CASE_TRANSITIONS`, the single source of truth the lane enforces.
 *  - escalation: strictly upward (`low < normal < high < urgent`, spec
 *    lines 1329–1334) — sidesteps/downgrades are refused with 400
 *    CASE_ESCALATION_INVALID, so the UI never offers them.
 *  - K2 dunning consent: automated OUTBOUND sends (`sms`/`whatsapp`,
 *    `source: automated`) require a consentRef; the wire refuses 403
 *    DUNNING_CONSENT_REQUIRED (spec lines 1400–1405) and the body schema
 *    defaults the source per type (spec lines 2544–2548). The UI mirrors
 *    the default + the requirement for immediate feedback — the server
 *    stays the source of truth.
 */

/**
 * Legal lifecycle edges, `from` → legal `to` states. Terminal rows are
 * empty. Mirrors the domain lane's CASE_TRANSITIONS table verbatim.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  open: ['in_progress'],
  in_progress: ['resolved', 'closed_inactive'],
  resolved: [],
  closed_inactive: [],
};

/** Higher number = more urgent; escalation may only climb this ladder. */
export const CASE_PRIORITY_RANK: Readonly<Record<CasePriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/** Stored statuses that still hold R8 coverage (terminal ⇒ released). */
export const LIVE_CASE_STATUSES: readonly CaseStatus[] = ['open', 'in_progress'];

export function isCaseLive(status: CaseStatus): boolean {
  return (LIVE_CASE_STATUSES as readonly string[]).includes(status);
}

/** The legal transition targets from `status` (empty for terminal states). */
export function legalTransitions(status: CaseStatus): readonly CaseStatus[] {
  return CASE_TRANSITIONS[status];
}

/**
 * Priorities the escalation op may target from `current` — strictly above
 * it on the ladder, never a sidestep or downgrade (the wire refuses those
 * with 400 CASE_ESCALATION_INVALID, so offering them would be a lie).
 */
export function escalationTargets(current: CasePriority): CasePriority[] {
  const rank = CASE_PRIORITY_RANK[current];
  return (['low', 'normal', 'high', 'urgent'] as const).filter(
    (candidate) => CASE_PRIORITY_RANK[candidate] > rank,
  );
}

// ---------------------------------------------------------------------------
// K2 dunning consent
// ---------------------------------------------------------------------------

/** Outbound send types the K2 consent gate covers. */
export const OUTBOUND_ACTION_TYPES: readonly CaseActionType[] = ['sms', 'whatsapp'];

export function isOutboundActionType(type: CaseActionType): boolean {
  return (OUTBOUND_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * The RecordActionBody default source (spec lines 2544–2548): outbound
 * types default to `automated` — "forgetting the flag must not bypass
 * consent" — everything else defaults to `manual`.
 */
export function defaultSourceFor(type: CaseActionType): CaseActionSource {
  return isOutboundActionType(type) ? 'automated' : 'manual';
}

/**
 * Does this type+source combination hit the K2 consent gate? Automated
 * outbound sends REQUIRE a consentRef or the wire refuses 403
 * DUNNING_CONSENT_REQUIRED (nothing is sent, nothing is appended).
 */
export function requiresDunningConsent(
  type: CaseActionType,
  source: CaseActionSource,
): boolean {
  return isOutboundActionType(type) && source === 'automated';
}

// ---------------------------------------------------------------------------
// Action ladder
// ---------------------------------------------------------------------------

/** Human labels for lifecycle targets (used on transition affordances). */
export const TRANSITION_LABELS: Readonly<Record<CaseStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed_inactive: 'Closed (inactive)',
};

/** Human labels for action types. */
export const ACTION_TYPE_LABELS: Readonly<Record<CaseActionType, string>> = {
  call: 'Call',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  letter: 'Letter',
  fieldVisit: 'Field visit',
  escalation: 'Escalation',
};

/**
 * The action ladder for one case: every affordance the detail screen may
 * honestly offer, derived from the case view alone. Terminal cases expose
 * an empty ladder — the log is sealed (wire: 409 CASE_CLOSED).
 */
export interface CaseActionLadder {
  /** Legal lifecycle moves (with labels) for the transition flow. */
  transitions: ReadonlyArray<{ to: CaseStatus; label: string }>;
  /** Strictly-higher escalation targets for the escalation flow. */
  escalations: readonly CasePriority[];
  /** Action types the record-action flow may append. */
  recordableTypes: readonly CaseActionType[];
  /** Recorded-but-uncompleted actions the completion flow may stamp. */
  completableActionIds: string[];
}

export function caseActionLadder(
  c: Pick<CaseView, 'status' | 'priority' | 'actions'>,
): CaseActionLadder {
  if (!isCaseLive(c.status)) {
    return { transitions: [], escalations: [], recordableTypes: [], completableActionIds: [] };
  }
  return {
    transitions: legalTransitions(c.status).map((to) => ({
      to,
      label: TRANSITION_LABELS[to],
    })),
    escalations: escalationTargets(c.priority),
    recordableTypes: ['call', 'sms', 'whatsapp', 'letter', 'fieldVisit', 'escalation'],
    completableActionIds: c.actions
      .filter((action) => action.completedAt === null)
      .map((action) => action.id),
  };
}

// ---------------------------------------------------------------------------
// Badge tones (state machine badges — consistent color semantics)
// ---------------------------------------------------------------------------

export type BadgeToneName = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * Stored status → badge tone. Lifecycle depth: open (info) → in_progress
 * (info, stronger label) → resolved (success) → closed_inactive (neutral).
 */
export function statusBadgeTone(status: CaseStatus): BadgeToneName {
  switch (status) {
    case 'open':
      return 'info';
    case 'in_progress':
      return 'info';
    case 'resolved':
      return 'success';
    case 'closed_inactive':
      return 'neutral';
  }
}

/**
 * DERIVED overlay → badge tone. waiting (neutral), promised (warning — a
 * commitment to keep), disputed (danger — money at risk). Stored statuses
 * fall through to statusBadgeTone.
 */
export function derivedStatusBadgeTone(derived: CaseView['derivedStatus']): BadgeToneName {
  switch (derived) {
    case 'promised':
      return 'warning';
    case 'disputed':
      return 'danger';
    case 'waiting':
      return 'neutral';
    default:
      return statusBadgeTone(derived);
  }
}

/** Priority → badge tone (the escalation ladder heats up). */
export function priorityBadgeTone(priority: CasePriority): BadgeToneName {
  switch (priority) {
    case 'low':
      return 'neutral';
    case 'normal':
      return 'info';
    case 'high':
      return 'warning';
    case 'urgent':
      return 'danger';
  }
}

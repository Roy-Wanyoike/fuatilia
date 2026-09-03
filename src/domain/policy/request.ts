/**
 * ActionRequest — the structured, plain-data input to the policy engine
 * (issue #34, VISION §3.9: "the safety layer between AI and financial
 * execution. AI never decides what it is allowed to do").
 *
 * The contract with callers is deliberately DUMB DATA (mirrors
 * disputes/pause.ts and the consent gates):
 *
 *   - actors are `{ type: human | ai_agent | integration, actorId }` — the
 *     id is opaque (no auth/RBAC here; the caller owns identity);
 *   - subject refs (orgId/customerId/receivableId/caseId) are opaque Uuids —
 *     the policy lane never dereferences another lane's entities;
 *   - consent/dispute/promise arrive as plain boolean FACTS — the consent
 *     registry is never consulted here (callers project it, like
 *     collections does for the K2 gate);
 *   - `autonomous` says the action would execute with NO human in the loop;
 *     a `human` actor claiming `autonomous: true` is a contradiction and is
 *     rejected (`POLICY_AUTONOMY_MISMATCH`).
 *
 * Two-tier input contract (house style, matching comms/guard.ts):
 *
 *   - MALFORMED input (bad actor type, bad risk class, bad channel,
 *     broken amount/currency pair, non-boolean flags) THROWS a stable
 *     `POLICY_*` DomainError — a bug, not a governance outcome;
 *   - an UNKNOWN action type is NOT malformed: it is a legitimate request the
 *     engine must GOVERN — `evaluate` denies it as a decision (safe by
 *     default) and records the audit event, so a misbehaving automation can
 *     never crash past the safety layer by sending garbage.
 *
 * Everything is pure: no I/O, no RNG, no Date.now() — evaluation time comes
 * from the caller's injected Clock.
 */
import { DomainError, CURRENCIES, type Currency, type Uuid } from '../shared';

// --- vocabularies -------------------------------------------------------------

/** Who is asking to act. Identity stays with the caller — the kind is all policy sees. */
export const ACTOR_TYPES = ['human', 'ai_agent', 'integration'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * The governed action vocabulary (issue #34). An ActionRequest may carry any
 * string as its actionType — anything outside this list is DENIED by the
 * engine (`POLICY_ACTION_UNKNOWN`, safe by default).
 */
export const ACTION_TYPES = [
  'send_reminder',
  'send_whatsapp',
  'send_sms',
  'offer_payment_plan',
  'issue_payment_link',
  'escalate',
  'write_off',
  'refund',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Customer-facing contact actions — the ones autonomy + consent rules govern. */
export const CONTACT_ACTION_TYPES: readonly ActionType[] = [
  'send_reminder',
  'send_whatsapp',
  'send_sms',
];

/** Money-losing actions — they require an amount, or the engine denies them. */
export const AMOUNT_REQUIRED_ACTION_TYPES: readonly ActionType[] = ['write_off', 'refund'];

export const RISK_CLASSES = ['low', 'elevated', 'high'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Channels a governed action may request (mirrors the dunning/comms channel vocabulary). */
export const CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Channels IMPLIED by the action type itself: requesting `send_whatsapp`
 * IS requesting the whatsapp channel (same for sms). `send_reminder` is
 * channel-generic and must name its channel explicitly. The engine evaluates
 * `channel` conditions and audits the EFFECTIVE channel (explicit wins,
 * implied fills in) and denies an explicit channel that contradicts the
 * action type (`POLICY_CHANNEL_ACTION_MISMATCH` — an automation asking to
 * "send whatsapp" over sms is trying to slip past channel-specific consent).
 */
export const IMPLIED_CHANNEL: Readonly<Partial<Record<ActionType, Channel>>> = {
  send_whatsapp: 'whatsapp',
  send_sms: 'sms',
};

// --- the request ----------------------------------------------------------------

export interface PolicyActor {
  readonly type: ActorType;
  /** Opaque actor id (user id, agent id, integration id) — never interpreted here. */
  readonly actorId: string;
}

export interface ActionRequest {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** Opaque receivable under the action; null when the action is not receivable-scoped. */
  readonly receivableId: Uuid | null;
  /** Opaque collections case under the action; null when not case-scoped. */
  readonly caseId: Uuid | null;
  readonly actor: PolicyActor;
  /** Any string is accepted structurally; unknown values are DENIED by the engine, never thrown. */
  readonly actionType: string;
  /** Minor units (bigint-safe integer). null ⇔ currency null — both or neither. */
  readonly amountMinor: number | null;
  readonly currency: Currency | null;
  readonly riskClass: RiskClass;
  /** Explicitly requested channel; null lets send_whatsapp/send_sms imply theirs. */
  readonly channel: Channel | null;
  /** Plain fact projected by the caller from the consent lane (K2) — no registry access here. */
  readonly consentPresent: boolean;
  /** Plain fact from the disputes lane (SPEC §29 pause). */
  readonly disputeOpen: boolean;
  /** Plain fact from the promises lane. */
  readonly promisePending: boolean;
  /** TRUE = would execute with no human in the loop. Contradictory for `human` actors. */
  readonly autonomous: boolean;
}

/** The channel a request would actually use: explicit request wins, implied fills in. */
export const effectiveChannel = (
  request: Pick<ActionRequest, 'actionType' | 'channel'>,
): Channel | null => {
  if (request.channel !== null) return request.channel;
  const implied = IMPLIED_CHANNEL[request.actionType as ActionType];
  return implied ?? null;
};

// --- validation (stable codes; malformed input throws, unknown actions do NOT) ----

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Validate one action request. Throws:
 *   - POLICY_ORG_REQUIRED / POLICY_CUSTOMER_REQUIRED — blank subject ids;
 *   - POLICY_SUBJECT_INVALID — a supplied receivableId/caseId was blank;
 *   - POLICY_ACTOR_REQUIRED — missing actor or blank actorId;
 *   - POLICY_ACTOR_TYPE_INVALID — unknown actor type;
 *   - POLICY_AUTONOMY_MISMATCH — a `human` actor claiming `autonomous: true`;
 *   - POLICY_AMOUNT_INVALID — amount without currency (or vice versa),
 *     negative / non-integer / unsafe-integer amount;
 *   - POLICY_CURRENCY_INVALID — unknown currency code;
 *   - POLICY_RISK_CLASS_INVALID — unknown risk class;
 *   - POLICY_CHANNEL_INVALID — unknown requested channel;
 *   - POLICY_REQUEST_FLAG_INVALID — a context flag was not a boolean;
 *   - POLICY_REQUEST_INVALID — the request itself is not an object.
 *
 * NOTE: `actionType` is deliberately NOT validated here (beyond "must be a
 * string") — unknown action types are a governed DENY decision, not a bug.
 */
export function assertActionRequest(request: ActionRequest): void {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new DomainError('POLICY_REQUEST_INVALID', 'an action request must be an object');
  }
  if (!isNonBlank(request.orgId)) {
    throw new DomainError('POLICY_ORG_REQUIRED', 'an action request requires an orgId');
  }
  if (!isNonBlank(request.customerId)) {
    throw new DomainError('POLICY_CUSTOMER_REQUIRED', 'an action request requires a customerId');
  }
  if (
    (request.receivableId !== null && !isNonBlank(request.receivableId)) ||
    (request.caseId !== null && !isNonBlank(request.caseId))
  ) {
    throw new DomainError(
      'POLICY_SUBJECT_INVALID',
      'receivableId/caseId must be non-blank ids or null',
    );
  }
  const actor = request.actor;
  if (actor === null || typeof actor !== 'object') {
    throw new DomainError('POLICY_ACTOR_REQUIRED', 'an action request requires an actor');
  }
  if (!(ACTOR_TYPES as readonly string[]).includes(actor.type)) {
    throw new DomainError('POLICY_ACTOR_TYPE_INVALID', `unknown actor type: ${String(actor.type)}`, {
      type: actor.type,
      allowed: ACTOR_TYPES,
    });
  }
  if (!isNonBlank(actor.actorId)) {
    throw new DomainError('POLICY_ACTOR_REQUIRED', 'an actor requires a non-blank actorId');
  }
  if (actor.type === 'human' && request.autonomous === true) {
    throw new DomainError(
      'POLICY_AUTONOMY_MISMATCH',
      'a human actor cannot claim an autonomous action — autonomous means no human in the loop',
    );
  }
  if (typeof request.actionType !== 'string') {
    throw new DomainError(
      'POLICY_ACTION_TYPE_INVALID',
      'actionType must be a string (unknown values are denied as decisions, not rejected)',
    );
  }
  const hasAmount = request.amountMinor !== null;
  const hasCurrency = request.currency !== null;
  if (hasAmount !== hasCurrency) {
    throw new DomainError(
      'POLICY_AMOUNT_INVALID',
      'amountMinor and currency must be supplied together (both or neither)',
    );
  }
  if (hasAmount) {
    const amount = request.amountMinor;
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    ) {
      throw new DomainError(
        'POLICY_AMOUNT_INVALID',
        `amountMinor must be a non-negative safe integer, got ${String(amount)}`,
      );
    }
    if (!(CURRENCIES as readonly string[]).includes(String(request.currency))) {
      throw new DomainError(
        'POLICY_CURRENCY_INVALID',
        `unknown currency: ${String(request.currency)}`,
        { allowed: CURRENCIES },
      );
    }
  }
  if (!(RISK_CLASSES as readonly string[]).includes(request.riskClass)) {
    throw new DomainError(
      'POLICY_RISK_CLASS_INVALID',
      `unknown risk class: ${String(request.riskClass)}`,
      { allowed: RISK_CLASSES },
    );
  }
  if (
    request.channel !== null &&
    !(CHANNELS as readonly string[]).includes(String(request.channel))
  ) {
    throw new DomainError('POLICY_CHANNEL_INVALID', `unknown channel: ${String(request.channel)}`, {
      allowed: CHANNELS,
    });
  }
  for (const flag of ['consentPresent', 'disputeOpen', 'promisePending', 'autonomous'] as const) {
    if (typeof request[flag] !== 'boolean') {
      throw new DomainError(
        'POLICY_REQUEST_FLAG_INVALID',
        `context flag ${flag} must be a boolean, got ${String(request[flag])}`,
      );
    }
  }
}

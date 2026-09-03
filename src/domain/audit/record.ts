/**
 * AuditRecord + the append-only store port (issue #53, SPEC §37).
 *
 * THE unified audit trail: one record per important action, carrying EVERY
 * §37 field — organization, actor, action, entity, entity id, timestamp,
 * request id, correlation id, ip/user-agent where appropriate, previous
 * state, new state, reason, approval information — plus `aiContext`, which
 * makes AI actions first-class auditable (agent kind + evidence refs, per
 * VISION §3.8 "every answer carries evidence refs").
 *
 * Append-only, twice over:
 *   1. the `AuditSink` port exposes ONLY `append(record) → AuditRecord`.
 *      There is no update, no delete, no rewind — the type system offers no
 *      such capability, so a programmer must reach around the port to break
 *      the guarantee;
 *   2. `createInMemoryAuditSink` (the deterministic, Clock-injected test
 *      store) deep-freezes every record it accepts and re-redacts the state
 *      snapshots on the way in — redaction cannot be bypassed by appending
 *      directly to the sink (the chain in `chain.ts` hashes the same
 *      redacted form, so verification covers what was stored).
 *
 * `occurredAt` is an ISO-8601 STRING (not a Date): the record is hashed over
 * canonical JSON, and strings survive that round-trip losslessly. The
 * instant always originates from an injected `Clock` (or from a projected
 * event envelope, itself clock-stamped upstream) — this module never reads
 * the wall clock.
 *
 * Deny-by-default: malformed input throws a stable `AUDIT_*` `DomainError`;
 * nothing partial is ever persisted.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { redactSnapshot, validateSnapshotShape } from './redact';

// --- vocabulary --------------------------------------------------------------------

/** Actor kinds — humans, machine credentials, the AI agent, and the platform itself. */
export const ACTOR_KINDS = ['user', 'apiKey', 'agent', 'system'] as const;
export type AuditActorKind = (typeof ACTOR_KINDS)[number];

/**
 * The closed action vocabulary — stable verbs; the entity type + entity id
 * carry the "what". New verbs join only by extending this table (a versioned
 * vocabulary change), never by free-form strings: free-form verbs would make
 * the trail unqueryable and let a misbehaving automation blur what it did.
 */
export const AUDIT_ACTIONS = [
  'create',     // the entity came into existence
  'update',     // in-place attribute change (snapshot delta)
  'transition', // lifecycle state change
  'cancel',     // withdrawn before completion
  'reverse',    // posted fact reversed (ledger / allocation)
  'write_off',  // receivable written off
  'refund',     // money returned to the customer
  'issue',      // credential / link / quote issued
  'revoke',     // credential / endpoint / grant revoked
  'approve',    // an approval was granted
  'send',       // outbound communication dispatched
  'ingest',     // payment / callback / webhook received
  'settle',     // transfer / reconciliation settled
  'redeem',     // payment link redeemed
  'access',     // read / export of data (the read path is audited too)
  'login',      // authentication event
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// --- value types ---------------------------------------------------------------------

/** The §37 actor — WHO did it. `id` is opaque (never an imported principal type). */
export interface AuditActor {
  readonly kind: AuditActorKind;
  /** Opaque principal id; blank is refused. */
  readonly id: string;
  /** The actor's own org — null ONLY for `system` (the platform itself). */
  readonly orgId: Uuid | null;
}

/** A redacted state snapshot: a plain JSON object, deep-frozen by redaction. */
export type AuditSnapshot = Readonly<Record<string, unknown>>;

/**
 * §37 approval information (pairs with the approval lane) — an OPAQUE ref
 * bundle: this lane never imports the approval lane, it records the handle.
 */
export interface AuditApproval {
  /** Opaque approval reference (the approval lane's id, verbatim). */
  readonly ref: string;
  /** Opaque approver principal id — null when recorded pre-decision. */
  readonly approverId: string | null;
  /** ISO-8601 decision instant — null when recorded pre-decision. */
  readonly decidedAt: string | null;
}

/**
 * §37 AI-action context — makes agent actions auditable as such: what KIND
 * of agent acted, and the evidence refs behind its decision (VISION §3.8).
 */
export interface AuditAiContext {
  readonly agentKind: string;
  readonly evidenceRefs: readonly string[];
}

/** Field size caps — the trail stays queryable, essays stay in documents. */
export const MAX_ID_LENGTH = 256;
export const MAX_REQUEST_ID_LENGTH = 256;
export const MAX_ENTITY_TYPE_LENGTH = 64;
export const MAX_IP_LENGTH = 64;
export const MAX_USER_AGENT_LENGTH = 512;
export const MAX_REASON_LENGTH = 1024;
export const MAX_HASH_LENGTH = 256;
export const MAX_REF_LENGTH = 256;
export const MAX_AGENT_KIND_LENGTH = 64;

// --- the record -----------------------------------------------------------------------

/**
 * The complete §37 record. Chain fields (`prevRecordHash` / `recordHash`)
 * ride ON the record so the trail is self-verifying: see `chain.ts`.
 */
export interface AuditRecord {
  readonly auditId: Uuid;
  readonly orgId: Uuid;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  /** ISO-8601 — the action instant, from an injected Clock. */
  readonly occurredAt: string;
  readonly requestId: string;
  readonly correlationId: string | null;
  /** Only where appropriate (access/login/ingest-class actions) — adapter discipline. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Redacted snapshots — null where not applicable (e.g. reads, logins). */
  readonly previousState: AuditSnapshot | null;
  readonly newState: AuditSnapshot | null;
  readonly reason: string | null;
  readonly approval: AuditApproval | null;
  readonly aiContext: AuditAiContext | null;
  /** Previous record's hash — null for the genesis record of a trail. */
  readonly prevRecordHash: string | null;
  /** H(prevHash ‖ canonical(record)) — see chain.ts. */
  readonly recordHash: string;
}

/** A validated, redacted §37 draft — everything except the chain fields. */
export type AuditDraft = Omit<AuditRecord, 'prevRecordHash' | 'recordHash'>;

/**
 * The append command. Required: who/what/when-context (§37 core). Optional
 * (absent OR null both mean "not applicable"): correlation, network context,
 * snapshots, reason, approval, aiContext. `occurredAt` may be pinned (the
 * event-projection path preserves the event's original instant); when
 * absent, the injected Clock stamps it.
 */
export interface AppendAuditInput {
  readonly auditId: Uuid;
  readonly orgId: Uuid;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly occurredAt?: string;
  readonly correlationId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly previousState?: AuditSnapshot | null;
  readonly newState?: AuditSnapshot | null;
  readonly reason?: string | null;
  readonly approval?: AuditApproval | null;
  readonly aiContext?: AuditAiContext | null;
}

// --- validation helpers ---------------------------------------------------------------

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when `raw` is a parseable ISO-8601 instant string. */
export const isIsoInstant = (raw: unknown): raw is string =>
  typeof raw === 'string' && ISO_PATTERN.test(raw) && !Number.isNaN(Date.parse(raw));

/** Non-blank string guard with a stable code — exported for projection/adapter reuse (user.ts precedent). */
export const assertNonBlank = (raw: unknown, code: string, label: string, max: number): string => {
  if (typeof raw !== 'string') {
    throw new DomainError(code, `${label} must be a string, got ${typeof raw}`);
  }
  const value = raw.trim();
  if (!value) throw new DomainError(code, `a non-blank ${label} is required`);
  if (value.length > max) {
    throw new DomainError(code, `${label} exceeds ${max} characters (got ${value.length})`);
  }
  return value;
};

/** Validated clock read — the only place this module touches time. */
export const assertAuditClock = (clock: Clock): Date => {
  if (!clock || typeof clock.now !== 'function') {
    throw new DomainError('AUDIT_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('AUDIT_CLOCK_INVALID', `clock.now() must return a valid Date, got ${String(now)}`);
  }
  return now;
};

export const assertActor = (raw: unknown): AuditActor => {
  if (!raw || typeof raw !== 'object') {
    throw new DomainError('AUDIT_ACTOR_INVALID', `actor must be an object, got ${typeof raw}`);
  }
  const actor = raw as Partial<AuditActor>;
  if (!(ACTOR_KINDS as readonly string[]).includes(actor.kind as string)) {
    throw new DomainError(
      'AUDIT_ACTOR_INVALID',
      `actor.kind must be one of ${ACTOR_KINDS.join(' | ')}, got ${String(actor.kind)}`,
    );
  }
  const id = assertNonBlank(actor.id, 'AUDIT_ACTOR_INVALID', 'actor.id', MAX_ID_LENGTH);
  if (actor.kind === 'system') {
    if (actor.orgId !== undefined && actor.orgId !== null) {
      throw new DomainError(
        'AUDIT_ACTOR_INVALID',
        'a system actor has no org — pass null (orgId belongs on the record)',
      );
    }
    return { kind: 'system', id, orgId: null };
  }
  const orgId = assertNonBlank(actor.orgId, 'AUDIT_ACTOR_INVALID', 'actor.orgId', MAX_ID_LENGTH);
  return { kind: actor.kind as AuditActorKind, id, orgId: orgId as Uuid };
};

export const assertAction = (raw: unknown): AuditAction => {
  if (typeof raw !== 'string' || !(AUDIT_ACTIONS as readonly string[]).includes(raw)) {
    throw new DomainError(
      'AUDIT_ACTION_INVALID',
      `action must be one of the closed vocabulary (${AUDIT_ACTIONS.join(' | ')}), got ${String(raw)}`,
      { action: String(raw) },
    );
  }
  return raw as AuditAction;
};

export const assertApproval = (raw: unknown): AuditApproval => {
  if (!raw || typeof raw !== 'object') {
    throw new DomainError('AUDIT_APPROVAL_INVALID', `approval must be an object, got ${typeof raw}`);
  }
  const approval = raw as Partial<AuditApproval>;
  const ref = assertNonBlank(approval.ref, 'AUDIT_APPROVAL_INVALID', 'approval.ref', MAX_REF_LENGTH);
  const approverId =
    approval.approverId === undefined || approval.approverId === null
      ? null
      : assertNonBlank(approval.approverId, 'AUDIT_APPROVAL_INVALID', 'approval.approverId', MAX_ID_LENGTH);
  const decidedAt =
    approval.decidedAt === undefined || approval.decidedAt === null
      ? null
      : isIsoInstant(approval.decidedAt)
        ? approval.decidedAt
        : (() => {
            throw new DomainError(
              'AUDIT_APPROVAL_INVALID',
              `approval.decidedAt must be ISO-8601, got ${String(approval.decidedAt)}`,
            );
          })();
  return { ref, approverId, decidedAt };
};

export const assertAiContext = (raw: unknown): AuditAiContext => {
  if (!raw || typeof raw !== 'object') {
    throw new DomainError('AUDIT_AI_CONTEXT_INVALID', `aiContext must be an object, got ${typeof raw}`);
  }
  const ai = raw as Partial<AuditAiContext>;
  const agentKind = assertNonBlank(ai.agentKind, 'AUDIT_AI_CONTEXT_INVALID', 'aiContext.agentKind', MAX_AGENT_KIND_LENGTH);
  if (!Array.isArray(ai.evidenceRefs)) {
    throw new DomainError(
      'AUDIT_AI_CONTEXT_INVALID',
      `aiContext.evidenceRefs must be an array of strings, got ${typeof ai.evidenceRefs}`,
    );
  }
  const evidenceRefs = ai.evidenceRefs.map((ref) =>
    assertNonBlank(ref, 'AUDIT_AI_CONTEXT_INVALID', 'aiContext.evidenceRefs entry', MAX_ID_LENGTH),
  );
  return { agentKind, evidenceRefs };
};

const optionalString = (raw: string | null | undefined, code: string, label: string, max: number): string | null =>
  raw === undefined || raw === null ? null : assertNonBlank(raw, code, label, max);

/**
 * Validate a state snapshot structurally (before redaction freezes it).
 * A snapshot that cannot survive canonical-JSON losslessly would silently
 * split the trail from its hash — refused.
 */
export const assertSnapshot = (raw: unknown, label: 'previousState' | 'newState'): AuditSnapshot => {
  if (raw === null || raw === undefined) {
    throw new DomainError('AUDIT_SNAPSHOT_INVALID', `${label} must be a plain object (use null for "not applicable") — got ${String(raw)}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('AUDIT_SNAPSHOT_INVALID', `${label} must be a plain object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  validateSnapshotShape(raw, label);
  return raw as AuditSnapshot;
};

const assertHashString = (raw: unknown, field: 'recordHash' | 'prevRecordHash'): string | null => {
  if (raw === null || raw === undefined) {
    if (field === 'recordHash') {
      throw new DomainError('AUDIT_HASH_MALFORMED', 'recordHash is required — build records through appendAuditRecord');
    }
    return null;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_HASH_LENGTH) {
    throw new DomainError('AUDIT_HASH_MALFORMED', `${field} must be a non-empty string of at most ${MAX_HASH_LENGTH} chars`);
  }
  return raw;
};

/**
 * Full structural validation of a persisted-shaped record — the sink's
 * gatekeeper (and verifyChain's pre-check). Every §37 field must be present
 * and well-formed; the chain fields must be well-shaped hash strings.
 * Throws a stable `AUDIT_*` code; never mutates.
 */
export function assertRecordShape(record: AuditRecord): void {
  if (!record || typeof record !== 'object') {
    throw new DomainError('AUDIT_RECORD_MALFORMED', `audit record must be an object, got ${typeof record}`);
  }
  assertNonBlank(record.auditId, 'AUDIT_RECORD_MALFORMED', 'auditId', MAX_ID_LENGTH);
  assertNonBlank(record.orgId, 'AUDIT_ORG_REQUIRED', 'orgId', MAX_ID_LENGTH);
  assertActor(record.actor);
  assertAction(record.action);
  assertNonBlank(record.entityType, 'AUDIT_ENTITY_TYPE_REQUIRED', 'entityType', MAX_ENTITY_TYPE_LENGTH);
  assertNonBlank(record.entityId, 'AUDIT_ENTITY_ID_REQUIRED', 'entityId', MAX_ID_LENGTH);
  if (!isIsoInstant(record.occurredAt)) {
    throw new DomainError(
      'AUDIT_OCCURRED_AT_INVALID',
      `occurredAt must be an ISO-8601 instant, got ${String(record.occurredAt)}`,
    );
  }
  assertNonBlank(record.requestId, 'AUDIT_REQUEST_ID_REQUIRED', 'requestId', MAX_REQUEST_ID_LENGTH);
  optionalString(record.correlationId, 'AUDIT_CORRELATION_ID_INVALID', 'correlationId', MAX_ID_LENGTH);
  optionalString(record.ip, 'AUDIT_IP_MALFORMED', 'ip', MAX_IP_LENGTH);
  optionalString(record.userAgent, 'AUDIT_USER_AGENT_MALFORMED', 'userAgent', MAX_USER_AGENT_LENGTH);
  optionalString(record.reason, 'AUDIT_REASON_MALFORMED', 'reason', MAX_REASON_LENGTH);
  if (record.previousState !== null) assertSnapshot(record.previousState, 'previousState');
  if (record.newState !== null) assertSnapshot(record.newState, 'newState');
  if (record.approval !== null) assertApproval(record.approval);
  if (record.aiContext !== null) assertAiContext(record.aiContext);
  assertHashString(record.recordHash, 'recordHash');
  assertHashString(record.prevRecordHash, 'prevRecordHash');
}

// --- the builder (the append path's front half) ----------------------------------------

/**
 * Validate the append command, stamp `occurredAt` (pinned value or the
 * injected Clock — read ONCE), REDACT the state snapshots, and return a
 * fresh, frozen draft. Inputs are never mutated; no secret survives.
 */
export function buildAuditDraft(input: AppendAuditInput, clock: Clock): AuditDraft {
  if (!input || typeof input !== 'object') {
    throw new DomainError('AUDIT_RECORD_MALFORMED', `append input must be an object, got ${typeof input}`);
  }
  const occurredAt =
    input.occurredAt !== undefined && input.occurredAt !== null
      ? isIsoInstant(input.occurredAt)
        ? input.occurredAt
        : (() => {
            throw new DomainError(
              'AUDIT_OCCURRED_AT_INVALID',
              `pinned occurredAt must be ISO-8601, got ${String(input.occurredAt)}`,
            );
          })()
      : assertAuditClock(clock).toISOString();

  const previousState =
    input.previousState === undefined || input.previousState === null
      ? null
      : (redactSnapshot(assertSnapshot(input.previousState, 'previousState')) as AuditSnapshot);
  const newState =
    input.newState === undefined || input.newState === null
      ? null
      : (redactSnapshot(assertSnapshot(input.newState, 'newState')) as AuditSnapshot);

  const draft: AuditDraft = {
    auditId: assertNonBlank(input.auditId, 'AUDIT_RECORD_MALFORMED', 'auditId', MAX_ID_LENGTH) as Uuid,
    orgId: assertNonBlank(input.orgId, 'AUDIT_ORG_REQUIRED', 'orgId', MAX_ID_LENGTH) as Uuid,
    actor: assertActor(input.actor),
    action: assertAction(input.action),
    entityType: assertNonBlank(input.entityType, 'AUDIT_ENTITY_TYPE_REQUIRED', 'entityType', MAX_ENTITY_TYPE_LENGTH),
    entityId: assertNonBlank(input.entityId, 'AUDIT_ENTITY_ID_REQUIRED', 'entityId', MAX_ID_LENGTH),
    occurredAt,
    requestId: assertNonBlank(input.requestId, 'AUDIT_REQUEST_ID_REQUIRED', 'requestId', MAX_REQUEST_ID_LENGTH),
    correlationId: optionalString(input.correlationId, 'AUDIT_CORRELATION_ID_INVALID', 'correlationId', MAX_ID_LENGTH),
    ip: optionalString(input.ip, 'AUDIT_IP_MALFORMED', 'ip', MAX_IP_LENGTH),
    userAgent: optionalString(input.userAgent, 'AUDIT_USER_AGENT_MALFORMED', 'userAgent', MAX_USER_AGENT_LENGTH),
    previousState,
    newState,
    reason: optionalString(input.reason, 'AUDIT_REASON_MALFORMED', 'reason', MAX_REASON_LENGTH),
    approval: input.approval === undefined || input.approval === null ? null : assertApproval(input.approval),
    aiContext: input.aiContext === undefined || input.aiContext === null ? null : assertAiContext(input.aiContext),
  };
  return Object.freeze(draft);
}

// --- the append-only port ---------------------------------------------------------------

/**
 * The store port. The ONLY capability is `append` — no update, no delete,
 * no truncate exists at the type level. That is the append-only guarantee
 * of SPEC §37: from the application's perspective the trail grows, never
 * shrinks, never rewrites.
 */
export interface AuditSink {
  append(record: AuditRecord): AuditRecord;
}

/** What `createInMemoryAuditSink` returns — the port plus read-only views for tests. */
export interface InMemoryAuditSink extends AuditSink {
  /** Frozen snapshot of the trail, in append order (never the live array). */
  records(): readonly AuditRecord[];
  size(): number;
}

/**
 * Deterministic in-memory audit sink for tests. Clock-injected (no wall
 * clock anywhere), and it RE-REDACTS every incoming record's snapshots —
 * the bypass-proof second gate. A record is refused when:
 *   - it is structurally invalid (stable `AUDIT_*` code from
 *     `assertRecordShape`),
 *   - its `occurredAt` lies in the future relative to the sink's clock
 *     (`AUDIT_OCCURRED_AT_FUTURE` — the trail never records what has not
 *     happened yet),
 *   - its `auditId` is already in this trail (`AUDIT_AUDIT_ID_TAKEN` —
 *     audit ids are unique forever; a duplicate is a replay bug, not a
 *     second fact).
 * On success it stores a deep-frozen copy and returns EXACTLY what was
 * stored (redacted + frozen) — the caller's view converges to the truth.
 */
export function createInMemoryAuditSink(clock: Clock): InMemoryAuditSink {
  assertAuditClock(clock);
  const trail: AuditRecord[] = [];
  const seenIds = new Set<string>();

  const append = (record: AuditRecord): AuditRecord => {
    assertRecordShape(record);
    const occurredAtMs = Date.parse(record.occurredAt);
    if (occurredAtMs > assertAuditClock(clock).getTime()) {
      throw new DomainError(
        'AUDIT_OCCURRED_AT_FUTURE',
        `record ${record.auditId} claims occurredAt ${record.occurredAt}, which is after the sink's clock — the trail never records the future`,
        { auditId: record.auditId, occurredAt: record.occurredAt },
      );
    }
    if (seenIds.has(record.auditId)) {
      throw new DomainError('AUDIT_AUDIT_ID_TAKEN', `audit record ${record.auditId} already exists in this trail`, {
        auditId: record.auditId,
      });
    }
    const previousState =
      record.previousState === null
        ? null
        : (redactSnapshot(assertSnapshot(record.previousState, 'previousState')) as AuditSnapshot);
    const newState =
      record.newState === null ? null : (redactSnapshot(assertSnapshot(record.newState, 'newState')) as AuditSnapshot);
    const stored: AuditRecord = Object.freeze({ ...record, previousState, newState });
    trail.push(stored);
    seenIds.add(stored.auditId);
    return stored;
  };

  return {
    append,
    records: (): readonly AuditRecord[] => Object.freeze([...trail]),
    size: (): number => trail.length,
  };
}

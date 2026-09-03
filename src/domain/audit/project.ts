/**
 * Event → AuditRecord projection + the trail's read model (issue #53).
 *
 * Per-lane audit events already exist across the repo; this module is the
 * UNIFIED TRAIL they project into:
 *
 *   `auditFromEvent(envelope, options)` — maps a PLAIN domain-event envelope
 *   (structural data only — NO lane imports, no catalog dependency) to a
 *   complete §37 draft ready for `appendAuditRecord`. The context segment of
 *   the event name becomes the entityType, the aggregateId becomes the
 *   entityId, the envelope's instant is preserved (the record attests the
 *   action, which happened when the event happened — never "now"), and
 *   `previousState`/`newState` slices ride inside the payload when the
 *   producer included them. The closed-vocabulary `action` is NOT guessed:
 *   the caller supplies it (deny-by-default — a projection that invents an
 *   action would blur the trail). Redaction still applies downstream on the
 *   append path.
 *
 *   `queryAuditTrail(records, filter)` — the read model: read-only, never
 *   mutates its input, returns a fresh array sorted by (occurredAt, then
 *   auditId) — a STABLE total order so pages and replays interleave
 *   identically. Filters: org / actor (id + kind) / entity (type + id) /
 *   inclusive time range / correlation / action. Bad filters throw the
 *   stable AUDIT_FILTER_INVALID — silence never widens visibility.
 *
 * Pure: no I/O, no RNG, no clock reads (time-range comparisons parse the
 * records' own ISO instants).
 */
import { DomainError, type Uuid } from '../shared';
import {
  ACTOR_KINDS,
  AUDIT_ACTIONS,
  MAX_ID_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  assertAction,
  assertActor,
  assertNonBlank,
  isIsoInstant,
  type AppendAuditInput,
  type AuditAction,
  type AuditActorKind,
  type AuditRecord,
  type AuditSnapshot,
} from './record';

// --- envelope projection -----------------------------------------------------------------

const EVENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$/;

/**
 * The plain envelope shape this lane accepts — structurally the repo's
 * `{ name, version, aggregateId, occurredAt, payload }` envelope (the
 * unified events lane adds eventId/correlationId). Only the fields the
 * projection needs are declared; extra fields are ignored.
 */
export interface AuditEventEnvelope {
  /** `'<context>.<aggregate><PastTenseVerb>'` — the repo naming convention. */
  readonly name: string;
  /** Owning aggregate — becomes the record's entityId. */
  readonly aggregateId: string;
  /** ISO-8601 — preserved as the record's occurredAt. */
  readonly occurredAt: string;
  /** Narrow, serializable payload. */
  readonly payload: Record<string, unknown>;
  /** Optional journey tie — preferred over the caller-supplied one. */
  readonly correlationId?: string;
}

/** The projection context the envelope cannot carry (§37 fields the producer left out). */
export interface AuditFromEventOptions {
  readonly auditId: Uuid;
  readonly orgId: Uuid;
  readonly actor: AppendAuditInput['actor'];
  /** Closed-vocabulary action — never derived from the event name. */
  readonly action: AuditAction;
  readonly requestId: string;
  /** Fallback when the envelope carries no correlationId. */
  readonly correlationId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly reason?: string | null;
  readonly approval?: AppendAuditInput['approval'];
  readonly aiContext?: AppendAuditInput['aiContext'];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const payloadSlice = (payload: Record<string, unknown>, key: string): AuditSnapshot | null => {
  const raw = payload[key];
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new DomainError(
      'AUDIT_EVENT_PAYLOAD_INVALID',
      `payload.${key} must be a plain object or null, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
      { key },
    );
  }
  return raw as AuditSnapshot;
};

/**
 * Project one plain event envelope into a complete §37 draft.
 *
 * Throws (stable codes): AUDIT_EVENT_NAME_MALFORMED,
 * AUDIT_EVENT_OCCURRED_AT_INVALID, AUDIT_EVENT_PAYLOAD_INVALID (a broken
 * envelope), AUDIT_ACTOR_INVALID / AUDIT_ACTION_INVALID /
 * AUDIT_ORG_REQUIRED / AUDIT_REQUEST_ID_REQUIRED (a broken context).
 */
export function auditFromEvent(envelope: AuditEventEnvelope, options: AuditFromEventOptions): AppendAuditInput {
  if (!envelope || typeof envelope !== 'object') {
    throw new DomainError('AUDIT_EVENT_PAYLOAD_INVALID', `envelope must be an object, got ${typeof envelope}`);
  }
  if (typeof envelope.name !== 'string' || !EVENT_NAME_PATTERN.test(envelope.name)) {
    throw new DomainError(
      'AUDIT_EVENT_NAME_MALFORMED',
      `event name must be '<context>.<aggregate><PastTenseVerb>' in lowerCamelCase, got ${String(envelope.name)}`,
      { name: String(envelope.name) },
    );
  }
  if (!isIsoInstant(envelope.occurredAt)) {
    throw new DomainError(
      'AUDIT_EVENT_OCCURRED_AT_INVALID',
      `envelope.occurredAt must be an ISO-8601 instant, got ${String(envelope.occurredAt)}`,
    );
  }
  if (!isPlainObject(envelope.payload)) {
    throw new DomainError('AUDIT_EVENT_PAYLOAD_INVALID', `envelope.payload must be a plain object, got ${typeof envelope.payload}`);
  }
  const context = envelope.name.slice(0, envelope.name.indexOf('.'));
  const entityType = context;
  const correlationId =
    envelope.correlationId !== undefined
      ? envelope.correlationId
      : options.correlationId !== undefined
        ? options.correlationId
        : null;
  return {
    auditId: assertNonBlank(options.auditId, 'AUDIT_RECORD_MALFORMED', 'auditId', MAX_ID_LENGTH) as Uuid,
    orgId: assertNonBlank(options.orgId, 'AUDIT_ORG_REQUIRED', 'orgId', MAX_ID_LENGTH) as Uuid,
    actor: assertActor(options.actor),
    action: assertAction(options.action),
    entityType,
    entityId: envelope.aggregateId,
    occurredAt: envelope.occurredAt,
    requestId: assertNonBlank(options.requestId, 'AUDIT_REQUEST_ID_REQUIRED', 'requestId', MAX_REQUEST_ID_LENGTH),
    correlationId,
    ip: options.ip ?? null,
    userAgent: options.userAgent ?? null,
    previousState: payloadSlice(envelope.payload, 'previousState'),
    newState: payloadSlice(envelope.payload, 'newState'),
    reason: options.reason ?? null,
    approval: options.approval ?? null,
    aiContext: options.aiContext ?? null,
  };
}

// --- the read model -------------------------------------------------------------------------

/** Read-only trail filter — every provided field must match (AND). */
export interface AuditTrailFilter {
  readonly orgId?: Uuid;
  readonly actorId?: string;
  readonly actorKind?: AuditActorKind;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly action?: AuditAction;
  /** ISO-8601 — INCLUSIVE lower bound on occurredAt. */
  readonly from?: string;
  /** ISO-8601 — INCLUSIVE upper bound on occurredAt. */
  readonly to?: string;
  readonly correlationId?: string;
  readonly requestId?: string;
}

const assertFilterField = (raw: unknown, label: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_ID_LENGTH) {
    throw new DomainError('AUDIT_FILTER_INVALID', `filter.${label} must be a non-blank string, got ${String(raw)}`);
  }
  return raw;
};

/**
 * Filter + stable-sort a trail. Read-only: the input array and its records
 * are never touched; the result is a fresh array ordered by occurredAt,
 * then auditId (code-unit order — deterministic across engines).
 */
export function queryAuditTrail(
  records: readonly AuditRecord[],
  filter: AuditTrailFilter = {},
): readonly AuditRecord[] {
  if (filter === null || typeof filter !== 'object') {
    throw new DomainError('AUDIT_FILTER_INVALID', `filter must be an object, got ${typeof filter}`);
  }
  if (filter.actorKind !== undefined && !(ACTOR_KINDS as readonly string[]).includes(filter.actorKind)) {
    throw new DomainError(
      'AUDIT_FILTER_INVALID',
      `filter.actorKind must be one of ${ACTOR_KINDS.join(' | ')}, got ${String(filter.actorKind)}`,
    );
  }
  if (filter.action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(filter.action)) {
    throw new DomainError(
      'AUDIT_FILTER_INVALID',
      `filter.action must be one of the closed vocabulary, got ${String(filter.action)}`,
    );
  }
  const fromMs =
    filter.from === undefined
      ? null
      : isIsoInstant(filter.from)
        ? Date.parse(filter.from)
        : (() => {
            throw new DomainError('AUDIT_FILTER_INVALID', `filter.from must be ISO-8601, got ${String(filter.from)}`);
          })();
  const toMs =
    filter.to === undefined
      ? null
      : isIsoInstant(filter.to)
        ? Date.parse(filter.to)
        : (() => {
            throw new DomainError('AUDIT_FILTER_INVALID', `filter.to must be ISO-8601, got ${String(filter.to)}`);
          })();
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new DomainError('AUDIT_FILTER_INVALID', `filter.from (${filter.from}) is after filter.to (${filter.to}) — an inverted range matches nothing by accident`);
  }
  const orgId = filter.orgId === undefined ? undefined : assertFilterField(filter.orgId, 'orgId');
  const actorId = filter.actorId === undefined ? undefined : assertFilterField(filter.actorId, 'actorId');
  const entityType = filter.entityType === undefined ? undefined : assertFilterField(filter.entityType, 'entityType');
  const entityId = filter.entityId === undefined ? undefined : assertFilterField(filter.entityId, 'entityId');
  const correlationId = filter.correlationId === undefined ? undefined : assertFilterField(filter.correlationId, 'correlationId');
  const requestId = filter.requestId === undefined ? undefined : assertFilterField(filter.requestId, 'requestId');

  const matches = records.filter((record) => {
    if (orgId !== undefined && record.orgId !== orgId) return false;
    if (actorId !== undefined && record.actor.id !== actorId) return false;
    if (filter.actorKind !== undefined && record.actor.kind !== filter.actorKind) return false;
    if (entityType !== undefined && record.entityType !== entityType) return false;
    if (entityId !== undefined && record.entityId !== entityId) return false;
    if (filter.action !== undefined && record.action !== filter.action) return false;
    if (correlationId !== undefined && record.correlationId !== correlationId) return false;
    if (requestId !== undefined && record.requestId !== requestId) return false;
    if (fromMs !== null && Date.parse(record.occurredAt) < fromMs) return false;
    if (toMs !== null && Date.parse(record.occurredAt) > toMs) return false;
    return true;
  });

  return matches.sort((a, b) => {
    const byTime = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    if (byTime !== 0) return byTime;
    if (a.auditId < b.auditId) return -1;
    if (a.auditId > b.auditId) return 1;
    return 0;
  });
}

/**
 * Audit-lane domain events (issue #53, SPEC §37).
 *
 *   audit.recordAppended   the ONE fact this lane emits — a record joined
 *                          the unified trail.
 *
 * The payload is deliberately NARROW: ids, actor kind, action, entity,
 * request/correlation ids, the chain hashes and the instant. The §37 detail
 * (snapshots, reason, approval, aiContext, ip/user-agent) lives ON THE
 * RECORD — the event is the pointer, the record is the evidence, and no
 * secret-bearing material ever rides the event bus (pinned by tests).
 *
 * Envelope mirrors the policy/crossborder lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` — `version` stays 1
 * until a breaking payload change; dates travel as ISO-8601 strings;
 * cross-lane ids are opaque strings so consumers never import this lane. A
 * broken injected clock surfaces as the stable AUDIT_CLOCK_INVALID.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { AuditAction, AuditActorKind, AuditRecord } from './record';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Validated clock read — the only place this lane touches time. */
const nowIso = (clock: Clock): string => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('AUDIT_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError(
      'AUDIT_CLOCK_INVALID',
      `clock.now() must return a valid Date, got ${String(now)}`,
    );
  }
  return now.toISOString();
};

/** Pure event factory — the only way this module builds events. */
export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): DomainEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: nowIso(clock),
    payload,
  };
}

// --- audit.recordAppended ----------------------------------------------------------------

/** `audit.recordAppended` — a record joined the unified append-only trail. */
export const RECORD_APPENDED = 'audit.recordAppended';

export interface RecordAppendedPayload {
  readonly auditId: Uuid;
  readonly orgId: Uuid;
  /** Actor KIND + opaque id — never actor PII, never the actor's org. */
  readonly actorKind: AuditActorKind;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly correlationId: string | null;
  /** Chain position — the tamper-evidence handles consumers can verify. */
  readonly prevRecordHash: string | null;
  readonly recordHash: string;
  /** ISO-8601 — the record's own action instant (=== record.occurredAt). */
  readonly occurredAt: string;
}

export type RecordAppendedEvent = DomainEvent<'audit.recordAppended', RecordAppendedPayload>;

/** Build the companion fact for a stored record. `clock` supplies the envelope instant. */
export function recordAppendedEvent(record: AuditRecord, clock: Clock): RecordAppendedEvent {
  const payload: RecordAppendedPayload = {
    auditId: record.auditId,
    orgId: record.orgId,
    actorKind: record.actor.kind,
    actorId: record.actor.id,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    requestId: record.requestId,
    correlationId: record.correlationId,
    prevRecordHash: record.prevRecordHash,
    recordHash: record.recordHash,
    occurredAt: record.occurredAt,
  };
  return domainEvent(RECORD_APPENDED, record.auditId, payload, clock);
}

/** Everything this lane emits. */
export type AuditLaneEvent = RecordAppendedEvent;

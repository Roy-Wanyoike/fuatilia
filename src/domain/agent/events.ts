/**
 * Agent-lane domain events (issue #35).
 *
 *   agent.queryServed   an agent capability query was served — the audit
 *                       trail that an agent (or UI, or integration) asked a
 *                       business question and Fuatilia answered it.
 *
 * Deliberately OPTIONAL and NARROW: the capability queries themselves stay
 * pure read-only projections (answers in, answers out). The adapter calls
 * `agentQueryServedEvent` when its audit policy wants the fact recorded. The
 * payload carries ids and counts only — never amounts (money is bigint and
 * never belongs in an event payload), never the answer body (consumers replay
 * the query against the same facts; the event only proves it was served).
 *
 * Envelope mirrors the promises/disputes lanes: plain object
 * `{ name, version, aggregateId, occurredAt, payload }`; `version` stays 1
 * until a breaking payload change. Naming follows the repo convention
 * `<context>.<aggregate><PastTenseVerb>` — `agent.queryServed`. ONE clock
 * read per event: `occurredAt` and `payload.servedAt` are the same instant
 * by construction (the validated read returned by assertAgentClock).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { assertAgentClock } from './facts';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Pure event factory — the only way this module builds events. */
export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  occurredAt: Date,
): DomainEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: occurredAt.toISOString(),
    payload,
  };
}

/** The capability queries this lane serves. */
export const AGENT_QUERY_KINDS = [
  'financial_state',
  'receivable_priorities',
  'collection_recommendations',
] as const;
export type AgentQueryKind = (typeof AGENT_QUERY_KINDS)[number];

export interface AgentQueryServedPayload {
  readonly orgId: Uuid;
  readonly queryId: Uuid;
  readonly query: AgentQueryKind;
  /** The customer/receivable focus of the query; null for org-wide queries. */
  readonly subjectId: Uuid | null;
  /** How many answer items were returned (1 for a financial state). */
  readonly answerCount: number;
  /** How many distinct evidence ids the answers carried. */
  readonly evidenceCount: number;
  /** ISO-8601 */
  readonly servedAt: string;
}

const assertCount = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      'AGENT_COUNT_INVALID',
      `${field} must be a non-negative safe integer, got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
};

/**
 * Build the `agent.queryServed` audit event. `aggregateId` is the query id
 * (the query is the aggregate this fact is about). Refuses malformed ids,
 * unknown query kinds and negative counts with stable codes.
 */
export function agentQueryServedEvent(
  args: {
    readonly orgId: Uuid;
    readonly queryId: Uuid;
    readonly query: AgentQueryKind;
    readonly subjectId?: Uuid | null;
    readonly answerCount: number;
    readonly evidenceCount: number;
  },
  clock: Clock,
): DomainEvent<'agent.queryServed', AgentQueryServedPayload> {
  const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const assertId = (value: unknown, field: string): Uuid => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new DomainError('AGENT_ID_MALFORMED', `${field} must be a canonical UUID, got ${String(value)}`, {
        field,
        value: String(value),
      });
    }
    return value as Uuid;
  };
  if (typeof args.query !== 'string' || !(AGENT_QUERY_KINDS as readonly string[]).includes(args.query)) {
    throw new DomainError(
      'AGENT_QUERY_KIND_INVALID',
      `unknown query kind ${String(args.query)} — known: ${AGENT_QUERY_KINDS.join(', ')}`,
      { query: String(args.query), allowed: AGENT_QUERY_KINDS },
    );
  }
  assertCount(args.answerCount, 'answerCount');
  assertCount(args.evidenceCount, 'evidenceCount');
  // ONE validated clock read — occurredAt and payload.servedAt are the same
  // instant by construction (no drift between envelope and payload).
  const now = assertAgentClock(clock);
  return domainEvent(
    'agent.queryServed',
    assertId(args.queryId, 'queryId'),
    {
      orgId: assertId(args.orgId, 'orgId'),
      queryId: assertId(args.queryId, 'queryId'),
      query: args.query,
      subjectId: args.subjectId == null ? null : assertId(args.subjectId, 'subjectId'),
      answerCount: args.answerCount,
      evidenceCount: args.evidenceCount,
      servedAt: now.toISOString(),
    },
    now,
  );
}

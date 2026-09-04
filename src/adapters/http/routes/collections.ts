/**
 * `/v1/collections/*` — the collections-case surface over the collections
 * lane (issue #60): open / act / read.
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows, in the style of `routes/auth.ts`; permissions come from
 * the closed vocabulary:
 *
 *   - `collections:act` — every command (open, transition, escalate, record
 *     action, complete action): acting on a case is exactly what the
 *     permission names.
 *   - `collections:read` — the case read model (detail + list).
 *
 * Handlers are wire→lane adapters ONLY: validate body shape
 * (`HTTP_BODY_INVALID`), look up referenced aggregates (`HTTP_CASE_NOT_FOUND`
 * / `HTTP_RECEIVABLE_NOT_FOUND`), call the lane's pure functions with the
 * injected clock/ids, persist through the injected ResourceStore, record the
 * lane's events, project serializable views. Refusal-as-value decisions map
 * per the kernel's status table:
 *
 *   - R8 case exclusivity (`CASE_ALREADY_OPEN` — at most one open case per
 *     receivable) → 409;
 *   - terminal-case refusals (`CASE_CLOSED`) → 409;
 *   - the K2 dunning-consent blocker is the lane's REFUSAL-AS-VALUE
 *     (`tryRecordAction`): the compliance fact
 *     `collections.dunningBlockedNoConsent` is recorded, then
 *     `DUNNING_CONSENT_REQUIRED` → 403 (aligned with the `*_NO_CONSENT`
 *     family). Nothing was sent — the action is not appended.
 *
 * Case-number sequence: the per-org controlled counter lives with the
 * adapter (case.ts) — the ResourceStore derives it from the stored rows
 * (`nextCaseSequence`). R8 coverage is plain data projected from the stored
 * cases via the lane's own `openCaseCoverageOf`. Referenced receivables are
 * verified to exist (`HTTP_RECEIVABLE_NOT_FOUND`) — the lane treats the ids
 * as opaque; the boundary checks referential integrity.
 *
 * Org scoping: cases carry `orgId`; list/detail are org-scoped to the
 * authenticated principal and a foreign-org case answers 404 (existence is
 * never leaked across orgs).
 */
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { DomainError } from '../../../domain/shared/errors';
import {
  CASE_PRIORITIES,
  deriveCaseStatus,
  openCase,
  openCaseCoverageOf,
  transitionCase,
  escalateCase,
  tryRecordAction,
  completeAction,
  type CaseAction,
  type CaseStatus,
  type CollectionsCase,
} from '../../../domain/collections';
import {
  HTTP_BODY_INVALID,
  HTTP_CASE_NOT_FOUND,
  HTTP_QUERY_INVALID,
  HTTP_RECEIVABLE_NOT_FOUND,
} from '../kernel/errors';
import type { RequestContext, RouteRecord } from '../kernel/types';
import { paginatedMeta, parsePagination, parseSorting } from '../pagination';
import { toStoredEvent, type ResourceRouteDeps } from '../runtime/resources';

// --- body field guards (wire-shape validation only — the domain re-validates values) ----

const requirePrincipal = (ctx: RequestContext): NonNullable<RequestContext['principal']> => {
  if (!ctx.principal) {
    // Unreachable: the kernel runs permission-gated handlers only with a
    // resolved principal — a violation is a kernel bug, so fail closed.
    throw new DomainError('HTTP_INTERNAL_ERROR', 'permission-gated handler reached without a principal');
  }
  return ctx.principal;
};

const bodyObject = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(HTTP_BODY_INVALID, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

const stringField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty string`);
  }
  return value.trim();
};

const uuidOf = (raw: string): Uuid => {
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) throw new Error(`invalid uuid: ${raw}`);
  return raw as Uuid;
};

const uuidField = (body: Record<string, unknown>, name: string): Uuid => {
  const raw = stringField(body, name);
  try {
    return uuidOf(raw);
  } catch {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a UUID`);
  }
};

/** A required array of unique UUIDs (R8 coverage is per receivable — duplicates are a shape error). */
const uuidArrayField = (body: Record<string, unknown>, name: string): Uuid[] => {
  const raw = body[name];
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== 'string')) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty array of UUIDs`);
  }
  const ids: Uuid[] = [];
  for (const entry of raw as string[]) {
    let id: Uuid;
    try {
      id = uuidOf(entry);
    } catch {
      throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty array of UUIDs`);
    }
    if (ids.some((existing) => existing === id)) {
      throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must not repeat a receivable id`);
    }
    ids.push(id);
  }
  return ids;
};

const optionalStringField = (body: Record<string, unknown>, name: string): string | undefined => {
  if (body[name] === undefined) return undefined;
  return stringField(body, name);
};

const optionalUuidField = (body: Record<string, unknown>, name: string): Uuid | undefined => {
  if (body[name] === undefined) return undefined;
  return uuidField(body, name);
};

const isoDateField = (body: Record<string, unknown>, name: string): Date => {
  const raw = stringField(body, name);
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an ISO-8601 timestamp`);
  }
  return at;
};

// --- serializable views -----------------------------------------------------------------

const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

export const actionView = (action: CaseAction) => ({
  id: action.id,
  type: action.type,
  scheduledFor: action.scheduledFor.toISOString(),
  outcome: action.outcome,
  completedAt: isoOrNull(action.completedAt),
  completedBy: action.completedBy,
  consentRef: action.consentRef,
  source: action.source,
  actorId: action.actorId,
  recordedAt: action.recordedAt.toISOString(),
});

export const caseView = (collectionsCase: CollectionsCase) => ({
  id: collectionsCase.id,
  caseNumber: collectionsCase.caseNumber,
  sequence: collectionsCase.sequence,
  orgId: collectionsCase.orgId,
  receivableIds: [...collectionsCase.receivableIds],
  collectorId: collectionsCase.collectorId,
  priority: collectionsCase.priority,
  status: collectionsCase.status,
  // The stored lifecycle stays minimal — WAITING/PROMISED/DISPUTED are the
  // lane's DERIVED overlay (derive.ts), computed here from child facts the
  // reference store does not hold (none yet → live cases derive 'waiting').
  derivedStatus: deriveCaseStatus(collectionsCase),
  openedAt: collectionsCase.openedAt.toISOString(),
  openedBy: collectionsCase.openedBy,
  closedAt: isoOrNull(collectionsCase.closedAt),
  closedBy: collectionsCase.closedBy,
  actions: collectionsCase.actions.map(actionView),
  history: collectionsCase.history.map((entry) => ({
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    actorId: entry.actorId,
    at: entry.at.toISOString(),
  })),
  priorityChanges: collectionsCase.priorityChanges.map((entry) => ({
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    actorId: entry.actorId,
    at: entry.at.toISOString(),
  })),
});

// --- the route table -----------------------------------------------------------------------

const SORTABLE = ['id', 'caseNumber', 'priority', 'status'] as const;

/** The opaque reference cursor is the offset into the deterministic order. */
const decodeCursor = (cursor: string): number => {
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' is not a valid page cursor`);
  }
  return offset;
};

export function collectionsRoutes(deps: ResourceRouteDeps): RouteRecord[] {
  const { store, clock, idGen } = deps;

  const findCase = (caseId: string, orgId: Uuid): CollectionsCase => {
    const found = store.cases().find((c) => c.id === caseId);
    // A foreign-org case does not exist for this principal — never leak it.
    if (!found || found.orgId !== orgId) {
      throw new DomainError(HTTP_CASE_NOT_FOUND, `case ${caseId} does not exist`);
    }
    return found;
  };

  const openCaseRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/collections/cases',
    permission: 'collections:act',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      // FULL wire-shape validation first (HTTP_BODY_INVALID), then referential
      // lookups (HTTP_*_NOT_FOUND), then the lane's decision.
      const receivableIds = uuidArrayField(body, 'receivableIds');
      const collectorId = uuidField(body, 'collectorId');
      const priority = optionalStringField(body, 'priority');
      // Wire-schema enum check (the lane re-validates with its own stable code):
      // the API's request shape enumerates the legal priority values.
      if (priority !== undefined && !(CASE_PRIORITIES as readonly string[]).includes(priority)) {
        throw new DomainError(
          HTTP_BODY_INVALID,
          `field 'priority' must be one of: ${CASE_PRIORITIES.join(', ')}`,
        );
      }
      const known = store.receivables();
      for (const receivableId of receivableIds) {
        if (!known.some((r) => r.id === receivableId)) {
          throw new DomainError(HTTP_RECEIVABLE_NOT_FOUND, `receivable ${receivableId} does not exist`);
        }
      }
      const result = openCase(
        {
          id: idGen() as Uuid,
          orgId: principal.orgId,
          receivableIds,
          collectorId,
          priority,
          openedBy: principal.principalId,
          // The org's controlled sequence, derived by the adapter's store.
          sequenceNo: store.nextCaseSequence(principal.orgId),
        },
        openCaseCoverageOf(store.cases()),
        clock,
      );
      store.saveCase(result.case);
      for (const event of result.events) store.record(toStoredEvent(event));
      return { status: 201, data: { case: caseView(result.case) } };
    },
  };

  const getCaseRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/collections/cases/:caseId',
    permission: 'collections:read',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const found = findCase(ctx.params['caseId'] ?? '', principal.orgId);
      return { status: 200, data: { case: caseView(found) } };
    },
  };

  const listCasesRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/collections/cases',
    permission: 'collections:read',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const views = store
        .cases()
        .filter((c) => c.orgId === principal.orgId)
        .map((c) => caseView(c) as unknown as Record<string, unknown>);
      const ordered =
        field === null ? views : [...views].sort((a, b) => {
          const cmp = String(a[field]).localeCompare(String(b[field]));
          return order === 'asc' ? cmp : -cmp;
        });
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { cases: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  const transitionRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/collections/cases/:caseId/transitions',
    permission: 'collections:act',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const found = findCase(ctx.params['caseId'] ?? '', principal.orgId);
      const body = bodyObject(ctx.body);
      const result = transitionCase(found, stringField(body, 'to') as CaseStatus, { reason: stringField(body, 'reason'), actorId: principal.principalId }, clock);
      store.saveCase(result.case);
      for (const event of result.events) store.record(toStoredEvent(event));
      return { status: 200, data: { case: caseView(result.case) } };
    },
  };

  const escalateRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/collections/cases/:caseId/escalations',
    permission: 'collections:act',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const found = findCase(ctx.params['caseId'] ?? '', principal.orgId);
      const body = bodyObject(ctx.body);
      const result = escalateCase(found, { to: stringField(body, 'to'), reason: stringField(body, 'reason'), actorId: principal.principalId }, clock);
      store.saveCase(result.case);
      for (const event of result.events) store.record(toStoredEvent(event));
      return { status: 200, data: { case: caseView(result.case) } };
    },
  };

  const recordActionRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/collections/cases/:caseId/actions',
    permission: 'collections:act',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const found = findCase(ctx.params['caseId'] ?? '', principal.orgId);
      const body = bodyObject(ctx.body);
      const result = tryRecordAction(
        found,
        {
          // Opaque URL-safe id (the lane's `<caseId>/actions/<n>` default
          // embeds slashes and could never travel as a path parameter).
          id: idGen(),
          type: stringField(body, 'type'),
          scheduledFor: isoDateField(body, 'scheduledFor'),
          outcome: optionalStringField(body, 'outcome'),
          actorId: principal.principalId,
          source: optionalStringField(body, 'source'),
          consentRef: optionalStringField(body, 'consentRef') ?? null,
        },
        clock,
      );
      if (!result.ok) {
        // K2 refusal-as-value: record the compliance fact, refuse on the wire
        // (403 — nothing was sent, the action is not appended).
        store.record(toStoredEvent(result.blockedEvent));
        throw new DomainError(result.error.code, result.error.message, result.error.details);
      }
      store.saveCase(result.case);
      for (const event of result.events) store.record(toStoredEvent(event));
      const appended = result.case.actions[result.case.actions.length - 1];
      return { status: 201, data: { case: caseView(result.case), action: appended ? actionView(appended) : null } };
    },
  };

  const completeActionRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/collections/cases/:caseId/actions/:actionId/completions',
    permission: 'collections:act',
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const found = findCase(ctx.params['caseId'] ?? '', principal.orgId);
      const body = bodyObject(ctx.body);
      const result = completeAction(
        found,
        ctx.params['actionId'] ?? '',
        { outcome: stringField(body, 'outcome'), actorId: optionalUuidField(body, 'actorId') },
        clock,
      );
      store.saveCase(result.case);
      // Completing emits no lane event: the issue-#8 catalog has no
      // case.actionCompleted — the sealed log carries the outcome.
      return { status: 200, data: { case: caseView(result.case) } };
    },
  };

  return [
    openCaseRoute,
    getCaseRoute,
    listCasesRoute,
    transitionRoute,
    escalateRoute,
    recordActionRoute,
    completeActionRoute,
  ];
}

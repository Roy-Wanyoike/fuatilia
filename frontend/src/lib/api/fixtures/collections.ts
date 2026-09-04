// =============================================================================
// FIXTURES — derived verbatim from api/openapi/fuatilia.v1.yaml.
// PROVENANCE (collections): GET /v1/collections/cases 200 example — spec
// lines 1087–1109 (case id 4d5e6f70-8192-4a3b-8c4d-5e6f708192a3,
// caseNumber CASE-000007, sequence 7, org 00000000-0000-4000-8000-000000000901,
// receivableIds [6b8c9d0e-…], collector 7c9e6679-7425-40de-944b-e07fc1f90ae7,
// priority high, status open, derivedStatus waiting, meta.pagination
// { nextCursor: null, total: 1 }); GET /v1/collections/cases/{caseId} 200
// example — spec lines 1216–1249 (status in_progress, one completed `call`
// action id a1b2c3d4e5f60718293a4b5c, one history transition open →
// in_progress).
//
// These fixtures are consumed ONLY by *.test.ts(x) files.
// =============================================================================

import type { CaseView } from '../wire-types';

/** GET /v1/collections/cases 200 example row (spec lines 1090–1105). */
export const specCase: CaseView = {
  id: '4d5e6f70-8192-4a3b-8c4d-5e6f708192a3',
  caseNumber: 'CASE-000007',
  sequence: 7,
  orgId: '00000000-0000-4000-8000-000000000901',
  receivableIds: ['6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4'],
  collectorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  priority: 'high',
  status: 'open',
  derivedStatus: 'waiting',
  openedAt: '2026-09-01T08:30:00.000Z',
  openedBy: '00000000-0000-4000-8000-000000000902',
  closedAt: null,
  closedBy: null,
  actions: [],
  history: [],
  priorityChanges: [],
};

/** Spec lines 1087–1109 — the full success envelope of GET /v1/collections/cases. */
export const caseListExample = {
  data: { cases: [specCase] },
  meta: { pagination: { nextCursor: null, total: 1 } },
};

/**
 * GET /v1/collections/cases/{caseId} 200 example (spec lines 1216–1249):
 * status in_progress with a sealed action + history log.
 */
export const caseDetailExample = {
  data: {
    case: {
      ...specCase,
      status: 'in_progress',
      actions: [
        {
          id: 'a1b2c3d4e5f60718293a4b5c',
          type: 'call',
          scheduledFor: '2026-09-02T09:00:00.000Z',
          outcome: 'spoke to site foreman — promised part payment',
          completedAt: '2026-09-02T09:20:00.000Z',
          completedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          consentRef: null,
          source: 'manual',
          actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          recordedAt: '2026-09-01T09:00:00.000Z',
        },
      ],
      history: [
        {
          from: 'open',
          to: 'in_progress',
          reason: 'collector engaged',
          actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          at: '2026-09-01T09:00:00.000Z',
        },
      ],
    } satisfies CaseView,
  },
};

/**
 * POST /v1/collections/cases/{caseId}/actions 201 example (spec lines
 * 1427–1466): an OPEN uncompleted action — outcome/completedAt null.
 */
export const caseActionRecordedExample = {
  data: {
    case: {
      ...specCase,
      actions: [
        {
          id: 'a1b2c3d4e5f60718293a4b5c',
          type: 'call',
          scheduledFor: '2026-09-02T09:00:00.000Z',
          outcome: null,
          completedAt: null,
          completedBy: null,
          consentRef: null,
          source: 'manual',
          actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          recordedAt: '2026-09-01T09:00:00.000Z',
        },
      ],
      history: [],
    } satisfies CaseView,
  },
  // The response also carries `action` at the same level (spec lines
  // 1456–1466); omitted here — the read path decodes `case`.
};

/** Spec lines 1189–1193 — POST /v1/collections/cases 409 example (R8). */
export const caseAlreadyOpenExample = {
  error: {
    code: 'CASE_ALREADY_OPEN',
    message:
      'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 is already covered by open case 4d5e6f70-8192-4a3b-8c4d-5e6f708192a3 — close that case first (R8: at most one open case per receivable)',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 1261–1265 — GET /v1/collections/cases/{caseId} 404 example. */
export const caseNotFoundExample = {
  error: {
    code: 'HTTP_CASE_NOT_FOUND',
    message: 'case 4d5e6f70-8192-4a3b-8c4d-5e6f708192a3 does not exist',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

// Empty-page fixture — shape per components.schemas.CaseListResponse
// (spec lines 2470–2481). Synthesized content, test-only.
export const caseListEmptyExample = {
  data: { cases: [] },
  meta: { pagination: { nextCursor: null, total: 0 } },
};

// Promised-case variants (synthesized, schema-shaped) for derivation tables:
// derivedStatus 'promised' overlays exist in the contract enum
// (components.schemas.DerivedCaseStatus, spec lines 2359–2365).
export const syntheticPromisedCase: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000001',
  caseNumber: 'CASE-000008',
  sequence: 8,
  derivedStatus: 'promised',
  actions: [
    {
      id: 'dd0d0d0d0000000000000000000000a1',
      type: 'call',
      scheduledFor: '2026-09-04T09:00:00.000Z',
      outcome: 'promised to clear balance on 2026-09-04',
      completedAt: '2026-09-03T14:00:00.000Z',
      completedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      consentRef: null,
      source: 'manual',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-09-03T09:00:00.000Z',
    },
    {
      id: 'dd0d0d0d0000000000000000000000a2',
      type: 'call',
      scheduledFor: '2026-09-04T17:00:00.000Z',
      outcome: null,
      completedAt: null,
      completedBy: null,
      consentRef: null,
      source: 'manual',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-09-03T14:00:00.000Z',
    },
  ],
};

export const syntheticPromisedCaseMissed: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000002',
  caseNumber: 'CASE-000009',
  sequence: 9,
  derivedStatus: 'promised',
  actions: [
    {
      id: 'dd0d0d0d0000000000000000000000b1',
      type: 'fieldVisit',
      scheduledFor: '2026-09-01T09:00:00.000Z',
      outcome: null,
      completedAt: null,
      completedBy: null,
      consentRef: null,
      source: 'manual',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-08-30T09:00:00.000Z',
    },
  ],
};

export const syntheticDisputedCase: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000003',
  caseNumber: 'CASE-000010',
  sequence: 10,
  derivedStatus: 'disputed',
  actions: [
    {
      id: 'dd0d0d0d0000000000000000000000c1',
      type: 'letter',
      scheduledFor: '2026-09-01T09:00:00.000Z',
      outcome: null,
      completedAt: null,
      completedBy: null,
      consentRef: null,
      source: 'manual',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-08-30T09:00:00.000Z',
    },
  ],
};

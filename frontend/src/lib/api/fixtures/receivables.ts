// =============================================================================
// FIXTURES — derived verbatim from api/openapi/fuatilia.v1.yaml.
// PROVENANCE (receivables): GET /v1/receivables 200 example — spec lines
// 571–595 (`data.receivables[0]` + `meta.pagination { nextCursor: '20',
// total: 42 }`); GET /v1/receivables/{receivableId} 200 example — spec lines
// 621–641; 404 example — spec lines 651–655.
// Distinctive scalars pinned by contract.test.ts against the committed spec:
// receivable id 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4, invoice
// 0f1e2d3c-4b5a-4968-8776-6554433221ff, customer
// 11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b, minor 12500000 / 5000000 / 7500000,
// aging { daysPastDue: 20, bucket: '0-30' }, cursor '20', total 42.
//
// These fixtures are consumed ONLY by *.test.ts(x) files. No production
// module imports this directory (grep-gated in the lane's verification).
// =============================================================================

import type { ReceivableView } from '../wire-types';

/** GET /v1/receivables 200 example row (spec lines 574–591). */
export const specReceivable: ReceivableView = {
  id: '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-6554433221ff',
  customerId: '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b',
  currency: 'KES',
  original: { minor: 12500000, currency: 'KES' },
  applied: { minor: 5000000, currency: 'KES' },
  balance: { minor: 7500000, currency: 'KES' },
  state: 'partially_paid',
  overdue: true,
  openedAt: '2026-08-01T10:00:00.000Z',
  dueDate: '2026-08-15T00:00:00.000Z',
  settledAt: null,
  voidedAt: null,
  writeOff: null,
  uncollectibleReason: null,
  uncollectibleAt: null,
  recoveredAt: null,
  aging: { daysPastDue: 20, bucket: '0-30' },
};

/** Spec lines 571–595 — the full success envelope of GET /v1/receivables. */
export const receivableListExample = {
  data: { receivables: [specReceivable] },
  meta: { pagination: { nextCursor: '20', total: 42 } },
};

/** Spec lines 621–641 — GET /v1/receivables/{receivableId} 200 example. */
export const receivableDetailExample = {
  data: { receivable: specReceivable },
};

/** Spec lines 651–655 — GET /v1/receivables/{receivableId} 404 example. */
export const receivableNotFoundExample = {
  error: {
    code: 'HTTP_RECEIVABLE_NOT_FOUND',
    message: 'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 does not exist',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

// Empty-page fixture — the spec has no empty-list example; the shape follows
// components.schemas.ReceivableListResponse (spec lines 2153–2164) with an
// exhausted first page. Synthesized content is legitimate ONLY as a test
// fixture.
export const receivableListEmptyExample = {
  data: { receivables: [] },
  meta: { pagination: { nextCursor: null, total: 0 } },
};

// Additional structurally-valid receivables (synthesized, schema-shaped) for
// derivation tables in tests: one due "today", one deep-aged 90+.
export const syntheticReceivableDueToday: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000001',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322102',
  state: 'open',
  overdue: false,
  dueDate: '2026-09-04T00:00:00.000Z',
  aging: { daysPastDue: 0, bucket: '0-30' },
};

export const syntheticReceivableDeepAged: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000002',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322103',
  state: 'open',
  overdue: true,
  dueDate: '2026-05-01T00:00:00.000Z',
  aging: { daysPastDue: 126, bucket: '90+' },
};

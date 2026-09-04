// =============================================================================
// FIXTURES — derived verbatim from api/openapi/fuatilia.v1.yaml.
// PROVENANCE (payments): GET /v1/payments 200 example — spec lines 972–997
// (payment id 8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a, Daraja receipt
// externalRef SBK41XQ7RT, idempotencyKey daraja-c2b-SBK41XQ7RT, requested/
// confirmed/unapplied minor 750000 KES, meta.pagination { nextCursor: null,
// total: 1 }); GET /v1/payments/{paymentId} 200 example — spec lines
// 1022–1043; 404 example — spec lines 1053–1057.
//
// These fixtures are consumed ONLY by *.test.ts(x) files.
// =============================================================================

import type { PaymentView } from '../wire-types';

/** GET /v1/payments 200 example row (spec lines 975–993). */
export const specPayment: PaymentView = {
  id: '8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a',
  channel: 'c2b',
  externalRef: 'SBK41XQ7RT',
  idempotencyKey: 'daraja-c2b-SBK41XQ7RT',
  customerId: '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b',
  state: 'confirmed',
  currency: 'KES',
  requested: { minor: 750000, currency: 'KES' },
  confirmed: { minor: 750000, currency: 'KES' },
  unapplied: { minor: 750000, currency: 'KES' },
  declaredRefs: ['INV-2026-08-0001'],
  allocations: [],
  refunds: [],
  initiatedAt: '2026-09-04T10:00:00.000Z',
  confirmedAt: '2026-09-04T10:01:30.000Z',
  failedAt: null,
  failureCode: null,
  reversedAt: null,
  reversalReason: null,
};

/** Spec lines 972–997 — the full success envelope of GET /v1/payments. */
export const paymentListExample = {
  data: { payments: [specPayment] },
  meta: { pagination: { nextCursor: null, total: 1 } },
};

/** Spec lines 1022–1043 — GET /v1/payments/{paymentId} 200 example. */
export const paymentDetailExample = {
  data: { payment: specPayment },
};

/** Spec lines 1053–1057 — GET /v1/payments/{paymentId} 404 example. */
export const paymentNotFoundExample = {
  error: {
    code: 'HTTP_PAYMENT_NOT_FOUND',
    message: 'payment 8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a does not exist',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

// Empty-page fixture — shape per components.schemas.PaymentListResponse
// (spec lines 2301–2312). Synthesized content, test-only.
export const paymentListEmptyExample = {
  data: { payments: [] },
  meta: { pagination: { nextCursor: null, total: 0 } },
};

// Fully-allocated variant (synthesized, schema-shaped): confirmed and
// applied, unapplied 0 — used by derivation tables (not "unmatched").
export const syntheticPaymentFullyApplied: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000001',
  externalRef: 'SBK41XQ7RU',
  idempotencyKey: 'daraja-c2b-SBK41XQ7RU',
  state: 'allocated',
  unapplied: { minor: 0, currency: 'KES' },
  allocations: [
    {
      id: 'cc0c0c0c-0000-4000-8000-000000000001',
      receivableId: '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
      amount: { minor: 750000, currency: 'KES' },
      recordedAt: '2026-09-04T11:00:00.000Z',
    },
  ],
};

// Intake example row (spec lines 703–723, POST /v1/payments/intake 201):
// state initiated with confirmed null — the pre-confirmation shape.
export const syntheticPaymentInitiated: PaymentView = {
  ...specPayment,
  id: '8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a',
  state: 'initiated',
  confirmed: null,
  unapplied: { minor: 0, currency: 'KES' },
  confirmedAt: null,
};

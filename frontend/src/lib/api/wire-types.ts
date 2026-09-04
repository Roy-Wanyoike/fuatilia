import { z } from 'zod';
import { moneySchema } from './envelope';

/**
 * Wire views for the mounted /v1 resources, hand-derived from
 * api/openapi/fuatilia.v1.yaml → components.schemas (ReceivableView,
 * PaymentView + rows, CaseView + child records). Field names, nullability
 * and enums mirror the spec exactly; schemas are strict (see envelope.ts).
 */

const dateTimeSchema = z.string().datetime({ offset: true });
const nullableDateTimeSchema = z.string().datetime({ offset: true }).nullable();
const opaqueIdSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Receivables (components.schemas.ReceivableView, AgingView, WriteOffView)
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const agingViewSchema = z
  .object({
    daysPastDue: z.number().int().nonnegative(),
    bucket: z.enum(AGING_BUCKETS),
  })
  .strict();
export type AgingView = z.infer<typeof agingViewSchema>;

export const writeOffViewSchema = z
  .object({
    reason: z.string(),
    approvedBy: z.string(),
    writtenOffAt: dateTimeSchema,
  })
  .strict();
export type WriteOffView = z.infer<typeof writeOffViewSchema>;

export const RECEIVABLE_STATES = [
  'draft',
  'open',
  'partially_paid',
  'settled',
  'written_off',
  'recovered',
  'uncollectible',
  'voided',
] as const;
export type ReceivableState = (typeof RECEIVABLE_STATES)[number];

export const receivableViewSchema = z
  .object({
    id: opaqueIdSchema,
    invoiceId: opaqueIdSchema,
    customerId: opaqueIdSchema,
    currency: z.enum(['KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX']),
    original: moneySchema,
    applied: moneySchema,
    balance: moneySchema,
    state: z.enum(RECEIVABLE_STATES),
    overdue: z.boolean(),
    openedAt: nullableDateTimeSchema,
    dueDate: dateTimeSchema,
    settledAt: nullableDateTimeSchema,
    voidedAt: nullableDateTimeSchema,
    writeOff: writeOffViewSchema.nullable(),
    uncollectibleReason: z.string().nullable(),
    uncollectibleAt: nullableDateTimeSchema,
    recoveredAt: nullableDateTimeSchema,
    aging: agingViewSchema.nullable(),
  })
  .strict();
export type ReceivableView = z.infer<typeof receivableViewSchema>;

// ---------------------------------------------------------------------------
// Payments (components.schemas.PaymentView, AllocationRowView, RefundRowView)
// ---------------------------------------------------------------------------

export const PAYMENT_CHANNELS = ['c2b', 'stk'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export const PAYMENT_STATES = [
  'initiated',
  'pending_confirmation',
  'confirmed',
  'partially_allocated',
  'allocated',
  'unapplied',
  'failed',
  'reversed',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const allocationRowViewSchema = z
  .object({
    id: opaqueIdSchema,
    receivableId: opaqueIdSchema,
    amount: moneySchema,
    recordedAt: dateTimeSchema,
  })
  .strict();
export type AllocationRowView = z.infer<typeof allocationRowViewSchema>;

export const refundRowViewSchema = z
  .object({
    id: opaqueIdSchema,
    amount: moneySchema,
    reason: z.string(),
    recordedAt: dateTimeSchema,
  })
  .strict();
export type RefundRowView = z.infer<typeof refundRowViewSchema>;

/** `confirmed` is set exactly ONCE by the success callback; minor >= 1. */
const confirmedMoneySchema = z
  .object({
    minor: z.number().int().positive(),
    currency: z.enum(['KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX']),
  })
  .strict();

export const paymentViewSchema = z
  .object({
    id: opaqueIdSchema,
    channel: z.enum(PAYMENT_CHANNELS),
    externalRef: z.string(),
    idempotencyKey: z.string(),
    customerId: z.string().nullable(),
    state: z.enum(PAYMENT_STATES),
    currency: z.enum(['KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX']),
    requested: moneySchema,
    confirmed: confirmedMoneySchema.nullable(),
    unapplied: moneySchema,
    declaredRefs: z.array(z.string()),
    allocations: z.array(allocationRowViewSchema),
    refunds: z.array(refundRowViewSchema),
    initiatedAt: dateTimeSchema,
    confirmedAt: nullableDateTimeSchema,
    failedAt: nullableDateTimeSchema,
    failureCode: z.string().nullable(),
    reversedAt: nullableDateTimeSchema,
    reversalReason: z.string().nullable(),
  })
  .strict();
export type PaymentView = z.infer<typeof paymentViewSchema>;

// ---------------------------------------------------------------------------
// Collections cases (components.schemas.CaseView + child records)
// ---------------------------------------------------------------------------

export const CASE_STATUSES = ['open', 'in_progress', 'resolved', 'closed_inactive'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Stored statuses + the three DERIVED overlays (lane derive.ts). */
export const DERIVED_CASE_STATUSES = [
  ...CASE_STATUSES,
  'waiting',
  'promised',
  'disputed',
] as const;
export type DerivedCaseStatus = (typeof DERIVED_CASE_STATUSES)[number];

export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_ACTION_TYPES = [
  'call',
  'sms',
  'whatsapp',
  'letter',
  'fieldVisit',
  'escalation',
] as const;
export type CaseActionType = (typeof CASE_ACTION_TYPES)[number];

export const CASE_ACTION_SOURCES = ['automated', 'manual'] as const;
export type CaseActionSource = (typeof CASE_ACTION_SOURCES)[number];

export const caseActionViewSchema = z
  .object({
    id: opaqueIdSchema,
    type: z.enum(CASE_ACTION_TYPES),
    scheduledFor: dateTimeSchema,
    outcome: z.string().nullable(),
    completedAt: nullableDateTimeSchema,
    completedBy: z.string().nullable(),
    consentRef: z.string().nullable(),
    source: z.enum(CASE_ACTION_SOURCES),
    actorId: opaqueIdSchema,
    recordedAt: dateTimeSchema,
  })
  .strict();
export type CaseActionView = z.infer<typeof caseActionViewSchema>;

export const caseTransitionRecordSchema = z
  .object({
    from: z.enum(CASE_STATUSES),
    to: z.enum(CASE_STATUSES),
    reason: z.string(),
    actorId: opaqueIdSchema,
    at: dateTimeSchema,
  })
  .strict();
export type CaseTransitionRecord = z.infer<typeof caseTransitionRecordSchema>;

export const casePriorityChangeRecordSchema = z
  .object({
    from: z.enum(CASE_PRIORITIES),
    to: z.enum(CASE_PRIORITIES),
    reason: z.string(),
    actorId: opaqueIdSchema,
    at: dateTimeSchema,
  })
  .strict();
export type CasePriorityChangeRecord = z.infer<typeof casePriorityChangeRecordSchema>;

export const caseViewSchema = z
  .object({
    id: opaqueIdSchema,
    caseNumber: z.string(),
    sequence: z.number().int().positive(),
    orgId: opaqueIdSchema,
    receivableIds: z.array(opaqueIdSchema).min(1),
    collectorId: opaqueIdSchema,
    priority: z.enum(CASE_PRIORITIES),
    status: z.enum(CASE_STATUSES),
    derivedStatus: z.enum(DERIVED_CASE_STATUSES),
    openedAt: dateTimeSchema,
    openedBy: opaqueIdSchema,
    closedAt: nullableDateTimeSchema,
    closedBy: z.string().nullable(),
    actions: z.array(caseActionViewSchema),
    history: z.array(caseTransitionRecordSchema),
    priorityChanges: z.array(casePriorityChangeRecordSchema),
  })
  .strict();
export type CaseView = z.infer<typeof caseViewSchema>;

// ---------------------------------------------------------------------------
// Public capability views (HealthResponse, MetaResponse)
// ---------------------------------------------------------------------------

export const healthDataSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict();
export type HealthData = z.infer<typeof healthDataSchema>;

export const metaDataSchema = z
  .object({
    name: z.string(),
    apiVersion: z.string(),
    capabilities: z.array(z.string()),
  })
  .strict();
export type MetaData = z.infer<typeof metaDataSchema>;

// ---------------------------------------------------------------------------
// Response envelopes per operation (data payloads)
// ---------------------------------------------------------------------------

export const receivableDetailDataSchema = z
  .object({ receivable: receivableViewSchema })
  .strict();
export const receivableListDataSchema = z
  .object({ receivables: z.array(receivableViewSchema) })
  .strict();

export const paymentDetailDataSchema = z.object({ payment: paymentViewSchema }).strict();
export const paymentListDataSchema = z
  .object({ payments: z.array(paymentViewSchema) })
  .strict();

export const caseDetailDataSchema = z.object({ case: caseViewSchema }).strict();
export const caseListDataSchema = z.object({ cases: z.array(caseViewSchema) }).strict();

export type ReceivableDetailData = z.infer<typeof receivableDetailDataSchema>;
export type ReceivableListData = z.infer<typeof receivableListDataSchema>;
export type PaymentDetailData = z.infer<typeof paymentDetailDataSchema>;
export type PaymentListData = z.infer<typeof paymentListDataSchema>;
export type CaseDetailData = z.infer<typeof caseDetailDataSchema>;
export type CaseListData = z.infer<typeof caseListDataSchema>;

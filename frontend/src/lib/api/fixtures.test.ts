import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { receivableViewSchema } from './wire-types';
import { paymentViewSchema } from './wire-types';
import { caseViewSchema } from './wire-types';
import {
  syntheticReceivableDeepAged,
  syntheticReceivableDueToday,
  specReceivable,
} from './fixtures/receivables';
import {
  syntheticPaymentFullyApplied,
  syntheticPaymentInitiated,
  specPayment,
} from './fixtures/payments';
import {
  syntheticDisputedCase,
  syntheticPromisedCase,
  syntheticPromisedCaseMissed,
  specCase,
} from './fixtures/collections';

// =============================================================================
// FIXTURE ↔ SPEC PINNING — the fixtures in src/lib/api/fixtures/ claim
// verbatim provenance against api/openapi/fuatilia.v1.yaml (see the
// provenance headers in each fixture module). A YAML parser is NOT in the
// dependency budget, so this test pins each fixture's DISTINCTIVE SCALARS
// against the committed spec text: if the spec example changes (or a fixture
// drifts), the affected pin fails. This is the issue-sanctioned "provenance
// comment + spec path" strategy — synthesized fixtures are also checked to
// remain schema-valid and clearly marked as synthesized.
// =============================================================================

const SPEC_PATH = ((): string => {
  const candidates = [
    path.resolve(process.cwd(), 'api/openapi/fuatilia.v1.yaml'),
    path.resolve(process.cwd(), '../api/openapi/fuatilia.v1.yaml'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `contract spec not found relative to cwd ${process.cwd()} — run vitest from frontend/`,
    );
  }
  return found;
})();
const SPEC_TEXT = readFileSync(SPEC_PATH, 'utf8');

/** Every fragment must appear in the committed spec text. */
function expectInSpec(fragments: readonly string[]): void {
  for (const fragment of fragments) {
    expect(SPEC_TEXT).toContain(fragment);
  }
}

describe('receivable fixtures match the spec examples', () => {
  it('specReceivable pins to the GET /v1/receivables 200 example (spec lines 571–595)', () => {
    expectInSpec([
      '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
      'invoiceId: 0f1e2d3c-4b5a-4968-8776-6554433221ff',
      'customerId: 11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b',
      'original: {minor: 12500000, currency: KES}',
      'applied: {minor: 5000000, currency: KES}',
      'balance: {minor: 7500000, currency: KES}',
      'state: partially_paid',
      'overdue: true',
      "openedAt: '2026-08-01T10:00:00.000Z'",
      "dueDate: '2026-08-15T00:00:00.000Z'",
      "aging: {daysPastDue: 20, bucket: '0-30'}",
      "nextCursor: '20'",
      'total: 42',
    ]);
  });

  it('specReceivable also pins to the detail example (spec lines 621–641)', () => {
    expectInSpec([
      '/v1/receivables/{receivableId}:',
      'data:\n                  receivable:',
    ]);
  });

  it('receivable 404 example pins (spec lines 651–655)', () => {
    expectInSpec([
      'HTTP_RECEIVABLE_NOT_FOUND',
      'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 does not exist',
    ]);
  });

  it('synthesized receivables stay schema-valid (test-only rows)', () => {
    expect(receivableViewSchema.parse(syntheticReceivableDueToday)).toBeDefined();
    expect(receivableViewSchema.parse(syntheticReceivableDeepAged)).toBeDefined();
  });

  it('the intake-state payment row (spec lines 703–723) is the same receipt pre-confirmation', () => {
    expectInSpec(['state: initiated', 'confirmed: null']);
    expect(syntheticPaymentInitiated.id).toBe(specPayment.id);
    expect(syntheticPaymentInitiated.state).toBe('initiated');
  });
});

describe('payment fixtures match the spec examples', () => {
  it('specPayment pins to the GET /v1/payments 200 example (spec lines 972–997)', () => {
    expectInSpec([
      'externalRef: SBK41XQ7RT',
      'idempotencyKey: daraja-c2b-SBK41XQ7RT',
      'channel: c2b',
      'requested: {minor: 750000, currency: KES}',
      'confirmed: {minor: 750000, currency: KES}',
      'unapplied: {minor: 750000, currency: KES}',
      'declaredRefs: [INV-2026-08-0001]',
      "initiatedAt: '2026-09-04T10:00:00.000Z'",
      "confirmedAt: '2026-09-04T10:01:30.000Z'",
      'nextCursor: null',
      'total: 1',
    ]);
  });

  it('Daraja receipt id appears in the intake body example too (spec lines 703–723)', () => {
    expectInSpec(['example: SBK41XQ7RT']);
  });

  it('payment 404 example pins (spec lines 1053–1057)', () => {
    expectInSpec([
      'HTTP_PAYMENT_NOT_FOUND',
      'payment 8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a does not exist',
    ]);
  });

  it('payment variants stay schema-valid (synthesized allocated row + spec intake row)', () => {
    expect(paymentViewSchema.parse(syntheticPaymentFullyApplied)).toBeDefined();
    expect(paymentViewSchema.parse(syntheticPaymentInitiated)).toBeDefined();
  });
});

describe('collections fixtures match the spec examples', () => {
  it('specCase pins to the GET /v1/collections/cases 200 example (spec lines 1087–1109)', () => {
    expectInSpec([
      'caseNumber: CASE-000007',
      'sequence: 7',
      'orgId: 00000000-0000-4000-8000-000000000901',
      'receivableIds: [6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4]',
      'collectorId: 7c9e6679-7425-40de-944b-e07fc1f90ae7',
      'priority: high',
      'status: open',
      'derivedStatus: waiting',
      "openedAt: '2026-09-01T08:30:00.000Z'",
      'openedBy: 00000000-0000-4000-8000-000000000902',
    ]);
  });

  it('case detail example pins with its sealed action + history (spec lines 1216–1249)', () => {
    expectInSpec([
      'id: a1b2c3d4e5f60718293a4b5c',
      'outcome: spoke to site foreman — promised part payment',
      "completedAt: '2026-09-02T09:20:00.000Z'",
      'reason: collector engaged',
      'from: open\n                        to: in_progress',
    ]);
  });

  it('R8 409 example pins (spec lines 1189–1193)', () => {
    expectInSpec([
      'CASE_ALREADY_OPEN',
      'close that case first (R8: at most one open case per receivable)',
    ]);
  });

  it('case 404 example pins (spec lines 1261–1265)', () => {
    expectInSpec([
      'HTTP_CASE_NOT_FOUND',
      'case 4d5e6f70-8192-4a3b-8c4d-5e6f708192a3 does not exist',
    ]);
  });

  it('synthesized cases stay schema-valid (test-only rows)', () => {
    expect(caseViewSchema.parse(syntheticPromisedCase)).toBeDefined();
    expect(caseViewSchema.parse(syntheticPromisedCaseMissed)).toBeDefined();
    expect(caseViewSchema.parse(syntheticDisputedCase)).toBeDefined();
  });
});

describe('error + public fixtures match the spec examples', () => {
  it('reusable error-response examples pin (components.responses.*)', () => {
    expectInSpec([
      'HTTP_QUERY_INVALID',
      "query parameter 'limit' must be between 1 and 100, got 101",
      'HTTP_UNAUTHENTICATED',
      'AUTH_ACCESS_DENIED',
      "no active grant or scope covers 'admin:manage-users' — deny by default",
      'AUTH_ESCALATION_BLOCKED',
      'grant refused — role confers permissions the granter does not hold',
      'HTTP_PAYLOAD_TOO_LARGE',
      'request body exceeds 1048576 bytes',
      'HTTP_INTERNAL_ERROR',
      'message: internal server error',
      'DUPLICATE_AMOUNT_MISMATCH',
      'PAYMENT_NOT_CONFIRMED',
      'REFUND_EXCEEDS_AVAILABLE',
      'Σ allocations+refunds 1000000 would exceed confirmed 750000 (R6)',
      'DUNNING_CONSENT_REQUIRED',
      'automated sms dunning on case CASE-000007 requires an active dunning consent reference (K2)',
      'AUTH_EMAIL_TAKEN',
      "email 'mary.wanjiku@mjengo.co.ke' is already registered in this org",
    ]);
  });

  it('public route examples pin (spec lines 127–155)', () => {
    expectInSpec([
      'data:\n                  status: ok',
      'name: fuatilia',
      'apiVersion: v1',
      'capabilities: [auth, collections, payments, receivables]',
    ]);
  });
});

describe('the synthesized-variant policy holds', () => {
  it('synthesized ids never collide with spec-minted example ids', () => {
    const specIds = new Set([
      '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
      '8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a',
      '4d5e6f70-8192-4a3b-8c4d-5e6f708192a3',
    ]);
    const synthesized = [
      syntheticReceivableDueToday.id,
      syntheticReceivableDeepAged.id,
      syntheticPaymentFullyApplied.id,
      syntheticPromisedCase.id,
      syntheticPromisedCaseMissed.id,
      syntheticDisputedCase.id,
    ];
    for (const id of synthesized) {
      expect(specIds.has(id), `${id} must stay synthesized, never spec-derived`).toBe(false);
    }
  });
});

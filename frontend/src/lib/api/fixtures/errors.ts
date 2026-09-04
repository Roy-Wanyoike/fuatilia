// =============================================================================
// FIXTURES — derived verbatim from api/openapi/fuatilia.v1.yaml.
// PROVENANCE (errors + public): reusable error-response examples and public
// route examples.
//   - QueryInvalid 400 — spec lines 2598–2602 (HTTP_QUERY_INVALID).
//   - Unauthorized 401 — spec lines 2619–2623 (HTTP_UNAUTHENTICATED).
//   - AccessDenied 403 — spec lines 2639–2642 (AUTH_ACCESS_DENIED).
//   - EscalationBlocked 403 — spec lines 2659–2663 (AUTH_ESCALATION_BLOCKED).
//   - PayloadTooLarge 413 — spec lines 2672–2676 (HTTP_PAYLOAD_TOO_LARGE).
//   - InternalError 500 — spec lines 2689–2693 (HTTP_INTERNAL_ERROR).
//   - Payments 409 — spec lines 746–750 (DUPLICATE_AMOUNT_MISMATCH).
//   - Payments 409 — spec lines 928–932 (PAYMENT_NOT_CONFIRMED).
//   - Payments 422 — spec lines 942–946 (REFUND_EXCEEDS_AVAILABLE).
//   - Collections 403 — spec lines 1495–1499 (DUNNING_CONSENT_REQUIRED).
//   - GET /v1/health 200 — spec lines 127–129.
//   - GET /v1/meta 200 — spec lines 151–155.
//   - Auth admin 409 — spec lines 213–217 (AUTH_EMAIL_TAKEN).
// All error envelopes share requestId 9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70.
//
// These fixtures are consumed ONLY by *.test.ts(x) files.
// =============================================================================

/** Spec lines 2598–2602 — components.responses.QueryInvalid example. */
export const queryInvalidExample = {
  error: {
    code: 'HTTP_QUERY_INVALID',
    message: "query parameter 'limit' must be between 1 and 100, got 101",
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 2619–2623 — components.responses.Unauthorized example. */
export const unauthorizedExample = {
  error: {
    code: 'HTTP_UNAUTHENTICATED',
    message:
      'authentication required — supply "Authorization: Bearer <sessionToken>" or "Authorization: ApiKey <id>.<secret>"',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 2639–2642 — components.responses.AccessDenied example. */
export const accessDeniedExample = {
  error: {
    code: 'AUTH_ACCESS_DENIED',
    message: "no active grant or scope covers 'admin:manage-users' — deny by default",
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 2659–2663 — components.responses.EscalationBlocked example. */
export const escalationBlockedExample = {
  error: {
    code: 'AUTH_ESCALATION_BLOCKED',
    message: 'grant refused — role confers permissions the granter does not hold',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 2672–2676 — components.responses.PayloadTooLarge example. */
export const payloadTooLargeExample = {
  error: {
    code: 'HTTP_PAYLOAD_TOO_LARGE',
    message: 'request body exceeds 1048576 bytes',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 2689–2693 — components.responses.InternalError example. */
export const internalErrorExample = {
  error: {
    code: 'HTTP_INTERNAL_ERROR',
    message: 'internal server error',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 746–750 — POST /v1/payments/intake 409 example (tampered dup). */
export const duplicateAmountMismatchExample = {
  error: {
    code: 'DUPLICATE_AMOUNT_MISMATCH',
    message:
      'duplicate callback for SBK41XQ7RT carries KES 7,500.01 but the payment was initiated for KES 7,500.00',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 928–932 — refund reservation 409 example (R6 pre-condition). */
export const paymentNotConfirmedExample = {
  error: {
    code: 'PAYMENT_NOT_CONFIRMED',
    message:
      'refunds draw on confirmed funds; payment 8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a is initiated (R6)',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 942–946 — refund reservation 422 example (R6 ceiling). */
export const refundExceedsAvailableExample = {
  error: {
    code: 'REFUND_EXCEEDS_AVAILABLE',
    message: 'Σ allocations+refunds 1000000 would exceed confirmed 750000 (R6)',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 1495–1499 — case action 403 example (K2 dunning consent). */
export const dunningConsentRequiredExample = {
  error: {
    code: 'DUNNING_CONSENT_REQUIRED',
    message:
      'automated sms dunning on case CASE-000007 requires an active dunning consent reference (K2) — nothing was sent',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 213–217 — POST /v1/auth/users 409 example. */
export const authEmailTakenExample = {
  error: {
    code: 'AUTH_EMAIL_TAKEN',
    message: "email 'mary.wanjiku@mjengo.co.ke' is already registered in this org",
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

/** Spec lines 127–129 — GET /v1/health 200 example. */
export const healthExample = {
  data: {
    status: 'ok',
  },
};

/** Spec lines 151–155 — GET /v1/meta 200 example. */
export const metaExample = {
  data: {
    name: 'fuatilia',
    apiVersion: 'v1',
    capabilities: ['auth', 'collections', 'payments', 'receivables'],
  },
};

/**
 * NOT from the spec: a pattern-valid code OUTSIDE the known union, used by
 * contract.test.ts to prove the client refuses unknown codes with a tagged
 * `unknown-error` refusal instead of decoding them as legitimate.
 */
export const unknownErrorCodeExample = {
  error: {
    code: 'FUTURE_UNKNOWN_CODE',
    message: 'a code a future server version could mint',
  },
  requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
};

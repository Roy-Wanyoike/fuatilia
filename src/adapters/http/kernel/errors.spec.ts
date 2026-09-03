import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../domain/shared/errors';
import {
  errorBody,
  HTTP_BODY_MALFORMED,
  HTTP_INTERNAL_ERROR,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_ROUTE_NOT_FOUND,
  HTTP_UNAUTHENTICATED,
  KERNEL_STATUS,
  mapDomainError,
  statusForCode,
} from './errors';

describe('kernel error mapping — statusForCode (the §38 table)', () => {
  it.each([
    // kernel transport codes (exact)
    ['HTTP_PAYLOAD_TOO_LARGE', 413],
    ['HTTP_BODY_MALFORMED', 400],
    ['HTTP_BODY_INVALID', 400],
    ['HTTP_QUERY_INVALID', 400],
    ['HTTP_ROUTE_NOT_FOUND', 404],
    ['HTTP_METHOD_NOT_ALLOWED', 405],
    ['HTTP_UNAUTHENTICATED', 401],
    ['HTTP_USER_NOT_FOUND', 404],
    ['HTTP_ROLE_NOT_FOUND', 404],
    ['HTTP_SESSION_NOT_FOUND', 404],
    ['HTTP_INTERNAL_ERROR', 500],
    // authorization: audited denials → forbidden
    ['AUTH_ACCESS_DENIED', 403],
    ['AUTH_ESCALATION_BLOCKED', 403],
    // authentication pass-throughs: unusable credentials → unauthenticated
    ['KEY_UNKNOWN', 401],
    ['KEY_SECRET_MISMATCH', 401],
    ['KEY_REVOKED', 401],
    ['KEY_EXPIRED', 401],
    ['KEY_OWNER_INACTIVE', 401],
    // prefix families
    ['SESS_NOT_ACTIVE', 401],
    ['SESS_NOT_DUE', 401],
    ['SESSION_IDLE_EXPIRED', 401],
    ['SESSION_ABSOLUTE_EXPIRED', 401],
    ['SESSION_REVOKED', 401],
    ['PRINCIPAL_SUSPENDED', 401],
    ['PRINCIPAL_DEACTIVATED', 401],
    ['PRINCIPAL_REVOKED', 401],
    // suffix: *_NOT_FOUND
    ['AUTH_KEY_NOT_FOUND', 404],
    ['LINK_NOT_FOUND', 404],
    ['DARAJA_FIXTURE_NOT_FOUND', 404],
    // suffix: uniqueness conflicts → 409
    ['AUTH_EMAIL_TAKEN', 409],
    ['COMMS_MESSAGE_ID_TAKEN', 409],
    ['AUTH_GRANT_ID_TAKEN', 409],
    ['COMMS_CONVERSATION_EXISTS', 409],
    ['SEG_CUSTOMER_DUPLICATE', 409],
    ['ETIMS_SEQUENCE_DUPLICATE', 409],
    // suffix: state mismatches → 409 (exact KEY_SECRET_MISMATCH already pinned above)
    ['COMMS_MESSAGE_CUSTOMER_MISMATCH', 409],
    // *_NOT_* state conflicts → 409 (after *_NOT_FOUND)
    ['AUTH_USER_NOT_ACTIVE', 409],
    ['AUTH_ROLE_NOT_HELD', 409],
    ['ZZZ_NOT_ACTIVE', 409], // suffix family, not the SESS_ prefix
    ['PROMISE_NOT_DUE', 409],
    ['COMMS_MESSAGE_NOT_SENT', 409],
    // suffix: expired / exceeded / refused → 422
    ['QUOTE_EXPIRED', 422],
    ['PAYMENT_WINDOW_EXPIRED', 422],
    ['COMMS_ATTEMPT_LIMIT_EXCEEDED', 422],
    ['TRANSFER_LIMIT_REFUSED', 422],
    // suffix: blockers → 403
    ['COMMS_SEND_BLOCKED_NO_CONSENT', 403],
    ['ZZZ_BLOCKED', 403],
    // suffix: validation → 400
    ['AUTH_EMAIL_MALFORMED', 400],
    ['AUTH_ROLE_NAME_REQUIRED', 400],
    ['COMMS_TEMPLATE_VALUE_MISSING', 400],
    ['CORRIDOR_UNKNOWN', 400],
    ['LEDGER_AMOUNT_ZERO', 400],
    ['MONEY_UNPARSEABLE', 400],
    ['WEBHOOK_URL_INSECURE', 400],
    ['AUTH_SECRET_TOO_SHORT', 400],
    ['WEBHOOK_LABEL_TOO_LONG', 400],
    ['ALLOCATION_EMPTY', 400],
    ['INTAKE_DECLARED_REF_BLANK', 400],
    ['AUTH_PERMISSION_WILDCARD_FORBIDDEN', 400],
    // unmapped → 500 (fail closed, never invented statuses)
    ['TOTALLY_UNKNOWN_CODE', 500],
    ['NBA_PLAN_HAS_NO_RECOMMENDATION', 500],
    ['AMOUNT_MUST_BE_POSITIVE', 500],
  ] as const)('maps %s → %s', (code, expected) => {
    expect(statusForCode(code)).toBe(expected);
  });

  it('maps every kernel transport code through KERNEL_STATUS', () => {
    for (const [code, status] of Object.entries(KERNEL_STATUS)) {
      expect(statusForCode(code)).toBe(status);
    }
  });

  it('prefers the exact table over suffix rules (KEY_SECRET_MISMATCH is 401, not a 409 mismatch)', () => {
    expect(statusForCode('KEY_SECRET_MISMATCH')).toBe(401);
  });

  it('maps *_NOT_FOUND before the generic *_NOT_* conflict rule', () => {
    expect(statusForCode('AUTH_KEY_NOT_FOUND')).toBe(404);
    expect(statusForCode('AUTH_ROLE_NOT_HELD')).toBe(409);
  });
});

describe('mapDomainError', () => {
  it('keeps the stable code and message for mapped errors', () => {
    const mapped = mapDomainError(new DomainError('AUTH_EMAIL_TAKEN', 'email is already registered'));
    expect(mapped).toEqual({
      status: 409,
      code: 'AUTH_EMAIL_TAKEN',
      message: 'email is already registered',
      internal: false,
    });
  });

  it('replaces unmapped codes with the generic 500 — internals never reach the wire', () => {
    const mapped = mapDomainError(new DomainError('MYSTERY_CODE', 'stack trace with passwords'));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(HTTP_INTERNAL_ERROR);
    expect(mapped.message).toBe('internal server error');
    expect(mapped.internal).toBe(true);
    expect(mapped.message).not.toContain('passwords');
  });

  it('replaces unknown non-domain codes the same way', () => {
    const mapped = mapDomainError(new DomainError('WEIRD_SUFFIX', 'boom'));
    expect(mapped.status).toBe(500);
    expect(mapped.internal).toBe(true);
  });
});

describe('errorBody — the §38 error envelope', () => {
  it('is exactly { error: { code, message }, requestId }', () => {
    expect(errorBody(HTTP_PAYLOAD_TOO_LARGE, 'too big', 'req-1')).toEqual({
      error: { code: HTTP_PAYLOAD_TOO_LARGE, message: 'too big' },
      requestId: 'req-1',
    });
  });

  it('carries the unauthenticated code untouched', () => {
    expect(errorBody(HTTP_UNAUTHENTICATED, 'no credentials', 'req-2').error.code).toBe(HTTP_UNAUTHENTICATED);
  });

  it('echoes the request id on transport errors too', () => {
    expect(errorBody(HTTP_BODY_MALFORMED, 'bad json', 'req-3').requestId).toBe('req-3');
    expect(errorBody(HTTP_METHOD_NOT_ALLOWED, 'nope', 'req-4').requestId).toBe('req-4');
  });
});

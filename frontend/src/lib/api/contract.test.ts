import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFuatiliaClient,
  type ApiResult,
  type FetchLike,
  type Page,
} from './client';
import { listAllPages, listAllReceivables } from './pagination';
import {
  KNOWN_ERROR_CODES,
  isKnownErrorCode,
} from './error-codes';
import {
  caseListDataSchema,
  caseDetailDataSchema,
  caseViewSchema,
  healthDataSchema,
  metaDataSchema,
  paymentListDataSchema,
  paymentDetailDataSchema,
  paymentViewSchema,
  receivableListDataSchema,
  receivableDetailDataSchema,
  receivableViewSchema,
} from './wire-types';
import {
  syntheticReceivableDueToday,
  receivableDetailExample,
  receivableListEmptyExample,
  receivableListExample,
  receivableNotFoundExample,
  specReceivable,
} from './fixtures/receivables';
import {
  paymentDetailExample,
  paymentListEmptyExample,
  paymentListExample,
  paymentNotFoundExample,
  specPayment,
} from './fixtures/payments';
import {
  caseAlreadyOpenExample,
  caseDetailExample,
  caseListEmptyExample,
  caseListExample,
  caseNotFoundExample,
  specCase,
} from './fixtures/collections';
import {
  accessDeniedExample,
  authEmailTakenExample,
  duplicateAmountMismatchExample,
  dunningConsentRequiredExample,
  escalationBlockedExample,
  healthExample,
  internalErrorExample,
  metaExample,
  payloadTooLargeExample,
  paymentNotConfirmedExample,
  queryInvalidExample,
  refundExceedsAvailableExample,
  unauthorizedExample,
  unknownErrorCodeExample,
} from './fixtures/errors';

// =============================================================================
// CONTRACT TESTS — the client decodes every spec example and refuses what the
// contract refuses. Fixtures carry provenance comments citing the spec paths
// (see fixtures/*.ts); fixtures.test.ts pins the distinctive scalars against
// the committed spec text, so this file may treat the fixtures AS the spec
// examples.
// =============================================================================

const RID = '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

function jsonResponse(status: number, body: unknown, requestId = RID): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  });
}

function respondWith(status: number, body: unknown, requestId = RID): FetchLike {
  return async () => jsonResponse(status, body, requestId);
}

interface Captured {
  urls: string[];
  requestIds: string[];
  authorizations: (string | null)[];
  fetch: FetchLike;
  reply: (status: number, body: unknown) => void;
}

function capture(): Captured {
  const urls: string[] = [];
  const requestIds: string[] = [];
  const authorizations: (string | null)[] = [];
  let responder: (status: number, body: unknown) => Response = (s, b) => jsonResponse(s, b);
  return {
    urls,
    requestIds,
    authorizations,
    fetch: async (input, init) => {
      urls.push(String(input));
      const headers = new Headers(init.headers);
      requestIds.push(headers.get('x-request-id') ?? '');
      authorizations.push(headers.get('authorization'));
      return responder(200, {});
    },
    reply: (status, body) => {
      responder = () => jsonResponse(status, body);
    },
  };
}

function makeClient(over: Partial<Parameters<typeof createFuatiliaClient>[0]> = {}) {
  return createFuatiliaClient({
    baseUrl: 'http://contract.test',
    logger: null,
    requestIdGenerator: () => 'client-req-0001',
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. Every success example in the spec decodes through the client
// ---------------------------------------------------------------------------

describe('client decodes every spec success example', () => {
  it('GET /v1/receivables 200 example (spec lines 571–595)', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, receivableListExample) });
    const result = await client.listReceivables({ limit: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([specReceivable]);
    expect(result.pagination).toEqual({ nextCursor: '20', total: 42 });
    expect(result.requestId).toBe(RID);
  });

  it('GET /v1/receivables/{id} 200 example (spec lines 621–641)', async () => {
    const client = makeClient({
      fetchImpl: respondWith(200, receivableDetailExample),
    });
    const result = await client.getReceivable('6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(specReceivable);
  });

  it('GET /v1/payments 200 example (spec lines 972–997) — SBK receipt', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, paymentListExample) });
    const result = await client.listPayments();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([specPayment]);
    expect(result.data.rows[0]?.externalRef).toBe('SBK41XQ7RT');
    expect(result.pagination).toEqual({ nextCursor: null, total: 1 });
  });

  it('GET /v1/payments/{id} 200 example (spec lines 1022–1043)', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, paymentDetailExample) });
    const result = await client.getPayment('8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(specPayment);
    expect(result.data.confirmed).toEqual({ minor: 750000, currency: 'KES' });
  });

  it('GET /v1/collections/cases 200 example (spec lines 1087–1109) — CASE-000007', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, caseListExample) });
    const result = await client.listCases();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([specCase]);
    expect(result.data.rows[0]?.caseNumber).toBe('CASE-000007');
    expect(result.pagination).toEqual({ nextCursor: null, total: 1 });
  });

  it('GET /v1/collections/cases/{id} 200 example (spec lines 1216–1249) — sealed logs', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, caseDetailExample) });
    const result = await client.getCase('4d5e6f70-8192-4a3b-8c4d-5e6f708192a3');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(caseDetailExample.data.case);
    expect(result.data.status).toBe('in_progress');
    expect(result.data.actions).toHaveLength(1);
    expect(result.data.history).toEqual([
      {
        from: 'open',
        to: 'in_progress',
        reason: 'collector engaged',
        actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        at: '2026-09-01T09:00:00.000Z',
      },
    ]);
  });

  it('GET /v1/health 200 example (spec lines 127–129)', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, healthExample) });
    const result = await client.getHealth();
    expect(result).toEqual({
      ok: true,
      data: { status: 'ok' },
      pagination: null,
      requestId: RID,
    });
  });

  it('GET /v1/meta 200 example (spec lines 151–155)', async () => {
    const client = makeClient({ fetchImpl: respondWith(200, metaExample) });
    const result = await client.getMeta();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      name: 'fuatilia',
      apiVersion: 'v1',
      capabilities: ['auth', 'collections', 'payments', 'receivables'],
    });
  });

  it('empty-page envelopes decode (synthesized per ListResponse schemas)', async () => {
    const receivables = await makeClient({
      fetchImpl: respondWith(200, receivableListEmptyExample),
    }).listReceivables();
    expect(receivables.ok).toBe(true);
    if (receivables.ok) expect(receivables.data).toEqual({ rows: [], pagination: { nextCursor: null, total: 0 } });

    const payments = await makeClient({
      fetchImpl: respondWith(200, paymentListEmptyExample),
    }).listPayments();
    expect(payments.ok).toBe(true);
    if (payments.ok) expect(payments.data.rows).toEqual([]);

    const cases = await makeClient({
      fetchImpl: respondWith(200, caseListEmptyExample),
    }).listCases();
    expect(cases.ok).toBe(true);
    if (cases.ok) expect(cases.data.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Every spec example also decodes at the SCHEMA layer (strict schemas)
// ---------------------------------------------------------------------------

describe('wire schemas parse the spec examples strictly', () => {
  it('ReceivableView', () => {
    expect(receivableViewSchema.parse(specReceivable)).toEqual(specReceivable);
    expect(receivableListDataSchema.parse(receivableListExample.data)).toEqual(
      receivableListExample.data,
    );
    expect(receivableDetailDataSchema.parse(receivableDetailExample.data)).toEqual(
      receivableDetailExample.data,
    );
  });

  it('PaymentView', () => {
    expect(paymentViewSchema.parse(specPayment)).toEqual(specPayment);
    expect(paymentListDataSchema.parse(paymentListExample.data)).toEqual(paymentListExample.data);
    expect(paymentDetailDataSchema.parse(paymentDetailExample.data)).toEqual(
      paymentDetailExample.data,
    );
  });

  it('CaseView + sealed child logs', () => {
    expect(caseViewSchema.parse(specCase)).toEqual(specCase);
    expect(caseViewSchema.parse(caseDetailExample.data.case)).toEqual(caseDetailExample.data.case);
    expect(caseListDataSchema.parse(caseListExample.data)).toEqual(caseListExample.data);
    expect(caseDetailDataSchema.parse(caseDetailExample.data)).toEqual(caseDetailExample.data);
  });

  it('Health + Meta', () => {
    expect(healthDataSchema.parse(healthExample.data)).toEqual(healthExample.data);
    expect(metaDataSchema.parse(metaExample.data)).toEqual(metaExample.data);
  });
});

// ---------------------------------------------------------------------------
// 3. Every error example decodes to a TAGGED refusal (no throw)
// ---------------------------------------------------------------------------

const ERROR_EXAMPLES: ReadonlyArray<{
  name: string;
  status: number;
  body: unknown;
  code: string;
}> = [
  { name: 'QueryInvalid (spec 2598–2602)', status: 400, body: queryInvalidExample, code: 'HTTP_QUERY_INVALID' },
  { name: 'Unauthorized (spec 2619–2623)', status: 401, body: unauthorizedExample, code: 'HTTP_UNAUTHENTICATED' },
  { name: 'AccessDenied (spec 2639–2642)', status: 403, body: accessDeniedExample, code: 'AUTH_ACCESS_DENIED' },
  { name: 'EscalationBlocked (spec 2659–2663)', status: 403, body: escalationBlockedExample, code: 'AUTH_ESCALATION_BLOCKED' },
  { name: 'PayloadTooLarge (spec 2672–2676)', status: 413, body: payloadTooLargeExample, code: 'HTTP_PAYLOAD_TOO_LARGE' },
  { name: 'InternalError (spec 2689–2693)', status: 500, body: internalErrorExample, code: 'HTTP_INTERNAL_ERROR' },
  { name: 'intake 409 (spec 746–750)', status: 409, body: duplicateAmountMismatchExample, code: 'DUPLICATE_AMOUNT_MISMATCH' },
  { name: 'refund 409 (spec 928–932)', status: 409, body: paymentNotConfirmedExample, code: 'PAYMENT_NOT_CONFIRMED' },
  { name: 'refund 422 (spec 942–946)', status: 422, body: refundExceedsAvailableExample, code: 'REFUND_EXCEEDS_AVAILABLE' },
  { name: 'case action 403 (spec 1495–1499)', status: 403, body: dunningConsentRequiredExample, code: 'DUNNING_CONSENT_REQUIRED' },
  { name: 'auth admin 409 (spec 213–217)', status: 409, body: authEmailTakenExample, code: 'AUTH_EMAIL_TAKEN' },
  { name: 'receivable 404 (spec 651–655)', status: 404, body: receivableNotFoundExample, code: 'HTTP_RECEIVABLE_NOT_FOUND' },
  { name: 'payment 404 (spec 1053–1057)', status: 404, body: paymentNotFoundExample, code: 'HTTP_PAYMENT_NOT_FOUND' },
  { name: 'case 404 (spec 1261–1265)', status: 404, body: caseNotFoundExample, code: 'HTTP_CASE_NOT_FOUND' },
  { name: 'open case 409 R8 (spec 1189–1193)', status: 409, body: caseAlreadyOpenExample, code: 'CASE_ALREADY_OPEN' },
];

describe('client refuses 4xx/5xx with tagged values carrying spec codes', () => {
  for (const example of ERROR_EXAMPLES) {
    it(example.name, async () => {
      const client = makeClient({ fetchImpl: respondWith(example.status, example.body) });
      const result = await client.listReceivables();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const refusal = result.refusal;
      expect(refusal.tag).toBe('api-error');
      if (refusal.tag !== 'api-error') return;
      expect(refusal.status).toBe(example.status);
      expect(refusal.code).toBe(example.code);
      expect(refusal.message).toBe(
        (example.body as { error: { message: string } }).error.message,
      );
      expect(refusal.requestId).toBe(RID);
    });
  }

  it('isKnownErrorCode accepts every code the spec can put on the wire', () => {
    for (const example of ERROR_EXAMPLES) {
      expect(isKnownErrorCode(example.code), example.code).toBe(true);
    }
  });
});

describe('client refuses UNKNOWN error codes (fail-closed tagging)', () => {
  it('pattern-valid code outside the union → unknown-error with rawCode', async () => {
    const client = makeClient({ fetchImpl: respondWith(409, unknownErrorCodeExample) });
    const result = await client.listReceivables();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('unknown-error');
    if (result.refusal.tag !== 'unknown-error') return;
    expect(result.refusal.rawCode).toBe('FUTURE_UNKNOWN_CODE');
    expect(result.refusal.status).toBe(409);
    expect(result.refusal.requestId).toBe(RID);
    expect(isKnownErrorCode('FUTURE_UNKNOWN_CODE')).toBe(false);
  });

  it('malformed error envelope (no requestId) → decoding-error', async () => {
    const client = makeClient({
      fetchImpl: respondWith(500, { error: { code: 'HTTP_INTERNAL_ERROR', message: 'x' } }),
    });
    const result = await client.getReceivable('abc');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('decoding-error');
  });
});

// ---------------------------------------------------------------------------
// 4. Contract drift on success responses refuses (strict envelope)
// ---------------------------------------------------------------------------

describe('strict success envelope decoding', () => {
  it('unknown sibling field on the envelope → decoding-error', async () => {
    const client = makeClient({
      fetchImpl: respondWith(200, { ...receivableListExample, surprise: true }),
    });
    const result = await client.listReceivables();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('decoding-error');
    if (result.refusal.tag !== 'decoding-error') return;
    expect(result.refusal.message).toContain('success envelope did not match the contract');
  });

  it('unknown field inside a row → decoding-error (strict schema)', async () => {
    const body = {
      data: { receivables: [{ ...specReceivable, someNewField: 1 }] },
      meta: { pagination: { nextCursor: null, total: 1 } },
    };
    const client = makeClient({ fetchImpl: respondWith(200, body) });
    const result = await client.listReceivables();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('decoding-error');
    if (result.refusal.tag !== 'decoding-error') return;
    expect(result.refusal.message).toContain('response data did not match the contract');
  });

  it('meta on a non-paginated route → decoding-error (meta is list-only)', async () => {
    const client = makeClient({
      fetchImpl: respondWith(200, { data: { receivable: specReceivable }, meta: {} }),
    });
    const result = await client.getReceivable('abc');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('decoding-error');
  });

  it('non-JSON body → transport-error (invalid-response)', async () => {
    const client = makeClient({
      fetchImpl: async () =>
        new Response('<html>proxy exploded</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const result = await client.getHealth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({
      tag: 'transport-error',
      reason: 'invalid-response',
      message: expect.stringContaining('response was not JSON'),
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Transport refusals (dead base URL / timeout) — tagged, never thrown
// ---------------------------------------------------------------------------

describe('transport failures become tagged refusals', () => {
  it('fetch rejection (dead base URL) → transport-error network', async () => {
    const client = makeClient({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: undefined,
      timeoutMs: 2_000,
      logger: null,
    });
    // No fetchImpl override: this runs against the REAL fetch stack, so a
    // refused TCP connection is the genuine network failure the UI must
    // survive (mirrors the Command Center's dead-backend test).
    const result = await client.getHealth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('transport-error');
    if (result.refusal.tag !== 'transport-error') return;
    expect(result.refusal.reason).toBe('network');
  });

  it('AbortError-shaped rejection → transport-error timeout', async () => {
    const abortLike = new Error('The operation was aborted due to timeout');
    abortLike.name = 'TimeoutError';
    const client = makeClient({
      fetchImpl: async () => {
        throw abortLike;
      },
    });
    const result = await client.getHealth();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('transport-error');
    if (result.refusal.tag !== 'transport-error') return;
    expect(result.refusal.reason).toBe('timeout');
    expect(result.refusal.message).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// 6. Query-string building + client-side parameter validation
// ---------------------------------------------------------------------------

describe('list query building matches the kernel parameter contract', () => {
  it('encodes limit/cursor/sort/order', async () => {
    const cap = capture();
    cap.reply(200, caseListEmptyExample);
    const client = makeClient({ fetchImpl: cap.fetch });
    await client.listCases({ limit: 50, cursor: '20', sort: 'caseNumber', order: 'asc' });
    expect(cap.urls[0]).toBe(
      'http://contract.test/v1/collections/cases?limit=50&cursor=20&sort=caseNumber&order=asc',
    );
  });

  it('omits unset parameters (server-side default 20)', async () => {
    const cap = capture();
    cap.reply(200, receivableListEmptyExample);
    const client = makeClient({ fetchImpl: cap.fetch });
    await client.listReceivables();
    expect(cap.urls[0]).toBe('http://contract.test/v1/receivables');
  });

  it('refuses out-of-contract queries client-side without hitting the wire', async () => {
    const cap = capture();
    cap.reply(200, receivableListEmptyExample);
    const client = makeClient({ fetchImpl: cap.fetch });
    for (const bad of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { sort: 'bogus' as never },
      { cursor: '' },
    ]) {
      const result = await client.listReceivables(bad as Parameters<typeof client.listReceivables>[0]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.tag).toBe('decoding-error');
      if (result.refusal.tag !== 'decoding-error') return;
      expect(result.refusal.message).toContain('client-side query validation refused');
    }
    expect(cap.urls).toHaveLength(0);
  });

  it('encodes detail ids and attaches the Bearer credential when given', async () => {
    const cap = capture();
    cap.reply(200, paymentDetailExample);
    const client = makeClient({
      fetchImpl: cap.fetch,
      authTokenProvider: () => 'session-abc',
    });
    await client.getPayment('8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a');
    expect(cap.urls[0]).toBe(
      'http://contract.test/v1/payments/8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a',
    );
    expect(cap.authorizations[0]).toBe('Bearer session-abc');
    expect(cap.requestIds[0]).toBe('client-req-0001');
  });
});

// ---------------------------------------------------------------------------
// 7. Pagination decode + bounded cursor walk
// ---------------------------------------------------------------------------

describe('pagination decode and the bounded walk', () => {
  const page1 = {
    data: { receivables: [specReceivable] },
    meta: { pagination: { nextCursor: '20', total: 42 } },
  };
  const page2 = {
    data: { receivables: [syntheticReceivableDueToday] },
    meta: { pagination: { nextCursor: null, total: 42 } },
  };

  it('walks nextCursor until exhaustion, keeping meta.total', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      seen.push(url);
      return jsonResponse(200, url.includes('cursor=20') ? page2 : page1);
    };
    const client = makeClient({ fetchImpl });
    const result = await listAllReceivables(client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toEqual([specReceivable, syntheticReceivableDueToday]);
    expect(result.data.pagesFetched).toBe(2);
    expect(result.data.total).toBe(42);
    expect(result.data.truncated).toBe(false);
    expect(seen[1]).toContain('cursor=20');
  });

  it('stops at the page cap and flags truncation honestly', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, page1);
    };
    const client = makeClient({ fetchImpl });
    const result = await listAllPages<ReceivableRow>(
      (cursor) => client.listReceivables({ cursor: cursor ?? undefined }),
      { maxPages: 1 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.rows).toEqual([specReceivable]);
    expect(calls).toBe(1);
  });

  it('propagates the first failing page as a refusal (no partial success)', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(calls === 1 ? 200 : 401, calls === 1 ? page1 : unauthorizedExample);
    };
    const client = makeClient({ fetchImpl });
    const result = await listAllReceivables(client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toMatchObject({ tag: 'api-error', code: 'HTTP_UNAUTHENTICATED' });
  });
});

type ReceivableRow = typeof specReceivable;

// The walk types flow through the client's own generics; pin one compile-time
// identity so the helper's element type cannot silently drift.
const _typePin: (r: ApiResult<Page<ReceivableRow>>) => void = () => undefined;
void _typePin;

// ---------------------------------------------------------------------------
// 8. Error-code union ≡ the committed spec (set equality, no drift)
// ---------------------------------------------------------------------------

// vitest runs with cwd = frontend/ (the documented gate); resolve the
// committed contract relative to the repo root, whichever invocation root.
function findSpecPath(): string {
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
}

const SPEC_PATH = findSpecPath();

function extractSpecErrorCodes(specText: string): string[] {
  const start = specText.indexOf('Known wire codes');
  const end = specText.indexOf('Anything UNMAPPED');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('ErrorCode description block not found in the committed spec');
  }
  const block = specText.slice(start, end);
  return [...block.matchAll(/[A-Z][A-Z0-9_]{1,}/g)].map((m) => m[0]);
}

describe('KNOWN_ERROR_CODES ≡ components.schemas.ErrorCode in the spec', () => {
  it('set equality against the committed spec text', () => {
    const specText = readFileSync(SPEC_PATH, 'utf8');
    const specCodes = extractSpecErrorCodes(specText);
    expect(new Set(specCodes).size).toBe(specCodes.length); // no accidental dupes
    expect([...new Set(specCodes)].sort()).toEqual([...KNOWN_ERROR_CODES].sort());
  });

  it('every client code matches the wire pattern', () => {
    for (const code of KNOWN_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

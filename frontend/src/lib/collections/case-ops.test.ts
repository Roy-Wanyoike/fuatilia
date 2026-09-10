import { describe, expect, it } from 'vitest';
import {
  caseActionRecordedExample,
  caseAlreadyOpenExample,
  caseDetailExample,
  caseNotFoundExample,
} from '@/lib/api/fixtures/collections';
import { accessDeniedExample, dunningConsentRequiredExample, unauthorizedExample } from '@/lib/api/fixtures/errors';
import { specCase } from '@/lib/api/fixtures/collections';
import type { FetchLike } from '@/lib/api/client';
import {
  createCollectionsClient,
  openCaseBodySchema,
  recordActionBodySchema,
  type CollectionsCaseClient,
} from './case-ops';

// =============================================================================
// COLLECTIONS WRITE-OP CLIENT (issue #135): the five mutating case ops from
// api/openapi/fuatilia.v1.yaml §/v1/collections, decoded against the real
// contract. Refusals are tagged values — every documented envelope family
// (400/401/403/404/409/413/500 + transport + contract drift) decodes to a
// refusal carrying the server's CODE + requestId, never a throw.
// =============================================================================

const REQUEST_ID = '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

interface RecordedCall {
  url: string;
  method: string;
  contentType: string | null;
  requestId: string | null;
  body: string;
}

function jsonResponse(status: number, body: unknown, requestId = REQUEST_ID): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  });
}

/** Route stub that also records the wire shape of each call. */
function recordingFetch(
  routes: Record<string, { status: number; body: unknown }>,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const call: RecordedCall = {
      url,
      method: init.method,
      contentType:
        init.headers instanceof Object && 'Content-Type' in init.headers
          ? (init.headers as Record<string, string>)['Content-Type']
          : null,
      requestId:
        init.headers instanceof Object && 'x-request-id' in init.headers
          ? (init.headers as Record<string, string>)['x-request-id']
          : null,
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
  return { fetch: fetchImpl, calls };
}

const CASE_ID = specCase.id;

/** The CaseResponse envelope reshaped for a post-mutation view. */
function caseEnvelope(overrides: Partial<typeof specCase> = {}): unknown {
  return { data: { case: { ...specCase, ...overrides } } };
}

const OPEN_INPUT = {
  receivableIds: ['6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4'],
  collectorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  priority: 'high' as const,
};

const TRANSITION_INPUT = { to: 'in_progress' as const, reason: 'collector engaged' };
const ESCALATION_INPUT = { to: 'urgent' as const, reason: '60+ days overdue' };
const RECORD_INPUT = {
  type: 'call' as const,
  scheduledFor: '2026-09-02T09:00:00.000Z',
  source: 'manual' as const,
};
const COMPLETE_INPUT = { outcome: 'spoke to site foreman — promised part payment' };

/**
 * The full CaseActionRecordedResponse envelope (spec lines 1427–1466): the
 * post-append case AND the appended action at the same level of `data`.
 */
function actionRecordedEnvelope(): unknown {
  const recorded = caseActionRecordedExample.data.case;
  return { data: { case: recorded, action: recorded.actions[0] ?? null } };
}

function makeClient(fetchImpl: FetchLike): CollectionsCaseClient {
  return createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
}

describe('openCase (POST /v1/collections/cases, 201)', () => {
  it('posts the OpenCaseBody and decodes the CaseResponse envelope', async () => {
    const { fetch, calls } = recordingFetch({
      '/v1/collections/cases': { status: 201, body: caseEnvelope() },
    });
    const result = await makeClient(fetch).openCase(OPEN_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.caseNumber).toBe('CASE-000007');
    expect(result.requestId).toBe(REQUEST_ID);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('http://collections.test/v1/collections/cases');
    expect(call.method).toBe('POST');
    expect(call.contentType).toBe('application/json');
    expect(call.requestId).toBe('test-req-1');
    expect(JSON.parse(call.body)).toEqual(OPEN_INPUT);
  });

  it('surfaces the R8 conflict envelope: 409 CASE_ALREADY_OPEN with code + requestId', async () => {
    const { fetch } = recordingFetch({
      '/v1/collections/cases': { status: 409, body: caseAlreadyOpenExample },
    });
    const result = await makeClient(fetch).openCase(OPEN_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.tag).toBe('api-error');
    if (result.refusal.tag !== 'api-error') return;
    expect(result.refusal.status).toBe(409);
    expect(result.refusal.code).toBe('CASE_ALREADY_OPEN');
    expect(result.refusal.requestId).toBe(REQUEST_ID);
    expect(result.refusal.message).toContain('one open case per receivable');
  });

  it('surfaces 404 HTTP_RECEIVABLE_NOT_FOUND and 401 HTTP_UNAUTHENTICATED envelopes', async () => {
    const missing = {
      error: {
        code: 'HTTP_RECEIVABLE_NOT_FOUND',
        message: 'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 does not exist',
      },
      requestId: REQUEST_ID,
    };
    const { fetch } = recordingFetch({
      '/v1/collections/cases': { status: 404, body: missing },
    });
    const notFound = await makeClient(fetch).openCase(OPEN_INPUT);
    expect(notFound.ok).toBe(false);
    if (!notFound.ok && notFound.refusal.tag === 'api-error') {
      expect(notFound.refusal.code).toBe('HTTP_RECEIVABLE_NOT_FOUND');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    const { fetch: fetch401 } = recordingFetch({
      '/v1/collections/cases': { status: 401, body: unauthorizedExample },
    });
    const unauthorized = await makeClient(fetch401).openCase(OPEN_INPUT);
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok && unauthorized.refusal.tag === 'api-error') {
      expect(unauthorized.refusal.code).toBe('HTTP_UNAUTHENTICATED');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('surfaces 403 AUTH_ACCESS_DENIED and 500 HTTP_INTERNAL_ERROR envelopes', async () => {
    const { fetch } = recordingFetch({
      '/v1/collections/cases': { status: 403, body: accessDeniedExample },
    });
    const denied = await makeClient(fetch).openCase(OPEN_INPUT);
    expect(denied.ok).toBe(false);
    if (!denied.ok && denied.refusal.tag === 'api-error') {
      expect(denied.refusal.code).toBe('AUTH_ACCESS_DENIED');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    const internal = {
      error: { code: 'HTTP_INTERNAL_ERROR', message: 'internal server error' },
      requestId: REQUEST_ID,
    };
    const { fetch: fetch500 } = recordingFetch({
      '/v1/collections/cases': { status: 500, body: internal },
    });
    const failed = await makeClient(fetch500).openCase(OPEN_INPUT);
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.refusal.tag === 'api-error') {
      expect(failed.refusal.code).toBe('HTTP_INTERNAL_ERROR');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('refuses contract-drift envelopes as tagged decoding errors', async () => {
    const { fetch } = recordingFetch({
      '/v1/collections/cases': {
        status: 409,
        body: { error: { code: 'FUTURE_UNKNOWN_CODE', message: 'a future server minted this' }, requestId: REQUEST_ID },
      },
    });
    const unknown = await makeClient(fetch).openCase(OPEN_INPUT);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok && unknown.refusal.tag === 'unknown-error') {
      expect(unknown.refusal.rawCode).toBe('FUTURE_UNKNOWN_CODE');
      expect(unknown.refusal.requestId).toBe(REQUEST_ID);
    } else {
      expect.unreachable('expected an unknown-error refusal');
    }

    const { fetch: fetchMalformed } = recordingFetch({
      '/v1/collections/cases': { status: 500, body: { unexpected: 'shape' } },
    });
    const malformed = await makeClient(fetchMalformed).openCase(OPEN_INPUT);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.refusal.tag).toBe('decoding-error');
    } else {
      expect.unreachable('expected a decoding-error refusal');
    }
  });

  it('validates the body client-side before any wire traffic (shape discipline)', async () => {
    const { fetch, calls } = recordingFetch({
      '/v1/collections/cases': { status: 201, body: caseEnvelope() },
    });
    const client = makeClient(fetch);

    const empty = await client.openCase({ ...OPEN_INPUT, receivableIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.refusal.message).toContain('receivableIds');

    const duplicate = await client.openCase({
      ...OPEN_INPUT,
      receivableIds: [OPEN_INPUT.receivableIds[0]!, OPEN_INPUT.receivableIds[0]!],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.refusal.message).toContain('unique');

    const badUuid = await client.openCase({
      ...OPEN_INPUT,
      collectorId: 'not-a-uuid',
    });
    expect(badUuid.ok).toBe(false);

    const extraKey = await client.openCase({ ...OPEN_INPUT, urgency: 11 } as unknown as typeof OPEN_INPUT);
    expect(extraKey.ok).toBe(false);

    expect(calls).toHaveLength(0);
  });
});

describe('transitionCase (POST …/transitions, 200)', () => {
  it('posts the TransitionBody and decodes the post-transition view', async () => {
    const { fetch, calls } = recordingFetch({
      '/transitions': { status: 200, body: caseEnvelope({ status: 'in_progress' }) },
    });
    const result = await makeClient(fetch).transitionCase(CASE_ID, TRANSITION_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('in_progress');

    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${CASE_ID}/transitions`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(TRANSITION_INPUT);
  });

  it('surfaces the illegal-edge and unknown-status 400 envelopes verbatim', async () => {
    const { fetch } = recordingFetch({
      '/transitions': {
        status: 400,
        body: {
          error: { code: 'CASE_TRANSITION_INVALID', message: 'cannot move a case from resolved to in_progress' },
          requestId: REQUEST_ID,
        },
      },
    });
    const illegal = await makeClient(fetch).transitionCase(CASE_ID, TRANSITION_INPUT);
    expect(illegal.ok).toBe(false);
    if (!illegal.ok && illegal.refusal.tag === 'api-error') {
      expect(illegal.refusal.status).toBe(400);
      expect(illegal.refusal.code).toBe('CASE_TRANSITION_INVALID');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    const { fetch: fetchStatus } = recordingFetch({
      '/transitions': {
        status: 400,
        body: {
          error: { code: 'CASE_STATUS_INVALID', message: 'unknown case status: archived' },
          requestId: REQUEST_ID,
        },
      },
    });
    const unknownStatus = await makeClient(fetchStatus).transitionCase(CASE_ID, TRANSITION_INPUT);
    if (!unknownStatus.ok && unknownStatus.refusal.tag === 'api-error') {
      expect(unknownStatus.refusal.code).toBe('CASE_STATUS_INVALID');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('surfaces 404 HTTP_CASE_NOT_FOUND (foreign-org cases never leak)', async () => {
    const { fetch } = recordingFetch({
      '/transitions': { status: 404, body: caseNotFoundExample },
    });
    const result = await makeClient(fetch).transitionCase(CASE_ID, TRANSITION_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('HTTP_CASE_NOT_FOUND');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('refuses a blank reason and an empty caseId before the wire', async () => {
    const { fetch, calls } = recordingFetch({
      '/transitions': { status: 200, body: caseEnvelope() },
    });
    const client = makeClient(fetch);
    const blank = await client.transitionCase(CASE_ID, { to: 'in_progress', reason: '' });
    expect(blank.ok).toBe(false);
    const emptyId = await client.transitionCase('', TRANSITION_INPUT);
    expect(emptyId.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('escalateCase (POST …/escalations, 200)', () => {
  it('posts the EscalationBody and decodes the post-escalation view', async () => {
    const { fetch, calls } = recordingFetch({
      '/escalations': { status: 200, body: caseEnvelope({ priority: 'urgent' }) },
    });
    const result = await makeClient(fetch).escalateCase(CASE_ID, ESCALATION_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.priority).toBe('urgent');
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${CASE_ID}/escalations`,
    );
  });

  it('surfaces the strictly-upward refusal (400 CASE_ESCALATION_INVALID)', async () => {
    const { fetch } = recordingFetch({
      '/escalations': {
        status: 400,
        body: {
          error: {
            code: 'CASE_ESCALATION_INVALID',
            message: 'escalation must strictly raise the priority; high → high does not',
          },
          requestId: REQUEST_ID,
        },
      },
    });
    const result = await makeClient(fetch).escalateCase(CASE_ID, {
      to: 'high',
      reason: 'sidestep attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('CASE_ESCALATION_INVALID');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('surfaces the terminal-state refusal (409 CASE_CLOSED)', async () => {
    const { fetch } = recordingFetch({
      '/escalations': {
        status: 409,
        body: {
          error: { code: 'CASE_CLOSED', message: 'case CASE-000007 is resolved — nothing to escalate' },
          requestId: REQUEST_ID,
        },
      },
    });
    const result = await makeClient(fetch).escalateCase(CASE_ID, ESCALATION_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('CASE_CLOSED');
      expect(result.refusal.status).toBe(409);
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });
});

describe('recordCaseAction (POST …/actions, 201)', () => {
  it('posts the RecordActionBody and decodes case + appended action', async () => {
    const { fetch, calls } = recordingFetch({
      '/actions': { status: 201, body: actionRecordedEnvelope() },
    });
    const result = await makeClient(fetch).recordCaseAction(CASE_ID, RECORD_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.case.id).toBe(CASE_ID);
    expect(result.data.action?.type).toBe('call');
    expect(result.data.action?.completedAt).toBeNull();
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(RECORD_INPUT);
  });

  it('surfaces the K2 consent refusal (403 DUNNING_CONSENT_REQUIRED — nothing was sent)', async () => {
    const { fetch } = recordingFetch({
      '/actions': { status: 403, body: dunningConsentRequiredExample },
    });
    const result = await makeClient(fetch).recordCaseAction(CASE_ID, {
      type: 'sms',
      scheduledFor: '2026-09-02T09:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('DUNNING_CONSENT_REQUIRED');
      expect(result.refusal.message).toContain('nothing was sent');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('surfaces the sealed-log refusal (409 CASE_CLOSED) and the unknown-type 400 envelope', async () => {
    const { fetch } = recordingFetch({
      '/actions': {
        status: 409,
        body: {
          error: { code: 'CASE_CLOSED', message: 'case CASE-000007 is resolved — its action log is sealed' },
          requestId: REQUEST_ID,
        },
      },
    });
    const sealed = await makeClient(fetch).recordCaseAction(CASE_ID, RECORD_INPUT);
    if (!sealed.ok && sealed.refusal.tag === 'api-error') {
      expect(sealed.refusal.code).toBe('CASE_CLOSED');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    // The wire answers 400 CASE_ACTION_TYPE_INVALID for a type outside the
    // taxonomy (spec line 1469–1471); with a valid-typed body the envelope
    // decodes verbatim.
    const { fetch: fetchType } = recordingFetch({
      '/actions': {
        status: 400,
        body: {
          error: { code: 'CASE_ACTION_TYPE_INVALID', message: 'unknown case action type: fax' },
          requestId: REQUEST_ID,
        },
      },
    });
    const badType = await makeClient(fetchType).recordCaseAction(CASE_ID, {
      type: 'call',
      scheduledFor: '2026-09-02T09:00:00.000Z',
    });
    if (!badType.ok && badType.refusal.tag === 'api-error') {
      expect(badType.refusal.code).toBe('CASE_ACTION_TYPE_INVALID');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    // A type outside the enum is refused client-side BEFORE the wire
    // (defense in depth mirroring the server's taxonomy).
    const { fetch: fetchLocal, calls } = recordingFetch({
      '/actions': { status: 201, body: actionRecordedEnvelope() },
    });
    const local = await makeClient(fetchLocal).recordCaseAction(CASE_ID, {
      type: 'fax',
      scheduledFor: '2026-09-02T09:00:00.000Z',
    } as unknown as typeof RECORD_INPUT);
    expect(local.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a naive datetime without offset client-side (the wire requires date-time)', async () => {
    const { fetch, calls } = recordingFetch({
      '/actions': { status: 201, body: caseActionRecordedExample },
    });
    const result = await makeClient(fetch).recordCaseAction(CASE_ID, {
      type: 'call',
      scheduledFor: '2026-09-02T09:00',
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('completeCaseAction (POST …/completions, 200)', () => {
  const ACTION_ID = 'a1b2c3d4e5f60718293a4b5c';

  it('posts the CompleteActionBody and decodes the post-completion view', async () => {
    const { fetch, calls } = recordingFetch({
      '/completions': { status: 200, body: caseDetailExample },
    });
    const result = await makeClient(fetch).completeCaseAction(CASE_ID, ACTION_ID, COMPLETE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.actions[0]?.outcome).toBe('spoke to site foreman — promised part payment');
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${CASE_ID}/actions/${ACTION_ID}/completions`,
    );
  });

  it('surfaces exactly-once completion (409 CASE_ACTION_ALREADY_COMPLETED)', async () => {
    const { fetch } = recordingFetch({
      '/completions': {
        status: 409,
        body: {
          error: {
            code: 'CASE_ACTION_ALREADY_COMPLETED',
            message: `action ${ACTION_ID} was already completed at 2026-09-02T09:20:00.000Z`,
          },
          requestId: REQUEST_ID,
        },
      },
    });
    const result = await makeClient(fetch).completeCaseAction(CASE_ID, ACTION_ID, COMPLETE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('CASE_ACTION_ALREADY_COMPLETED');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });

  it('surfaces unknown-action 404 (CASE_ACTION_NOT_FOUND) and the blank-outcome 400 envelope', async () => {
    const { fetch } = recordingFetch({
      '/completions': {
        status: 404,
        body: {
          error: { code: 'CASE_ACTION_NOT_FOUND', message: `case CASE-000007 has no action ${ACTION_ID}` },
          requestId: REQUEST_ID,
        },
      },
    });
    const result = await makeClient(fetch).completeCaseAction(CASE_ID, ACTION_ID, COMPLETE_INPUT);
    if (!result.ok && result.refusal.tag === 'api-error') {
      expect(result.refusal.code).toBe('CASE_ACTION_NOT_FOUND');
    } else {
      expect.unreachable('expected an api-error refusal');
    }

    // A whitespace-only outcome satisfies the spec's minLength-1 SHAPE but
    // the lane refuses it as blank → the 400 envelope decodes verbatim.
    const { fetch: fetchBlank } = recordingFetch({
      '/completions': {
        status: 400,
        body: {
          error: {
            code: 'CASE_OUTCOME_REQUIRED',
            message: 'a case action requires a non-blank outcome (blank when completing)',
          },
          requestId: REQUEST_ID,
        },
      },
    });
    const blank = await makeClient(fetchBlank).completeCaseAction(CASE_ID, ACTION_ID, {
      outcome: '   ',
    });
    if (!blank.ok && blank.refusal.tag === 'api-error') {
      expect(blank.refusal.code).toBe('CASE_OUTCOME_REQUIRED');
    } else {
      expect.unreachable('expected an api-error refusal');
    }
  });
});

describe('transport failures', () => {
  it('decodes network failures into tagged transport refusals (never a throw)', async () => {
    const client = createCollectionsClient({
      baseUrl: 'http://collections.test',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
      requestIdGenerator: () => 'test-req-1',
    });
    const result = await client.transitionCase(CASE_ID, TRANSITION_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.tag).toBe('transport-error');
      if (result.refusal.tag === 'transport-error') {
        expect(result.refusal.reason).toBe('network');
      }
    } else {
      expect.unreachable('expected a transport refusal');
    }
  });
});

describe('request-body schemas (spec lines 2500–2563)', () => {
  it('keeps the strict shape: unknown keys and malformed datetimes are refused', () => {
    expect(openCaseBodySchema.safeParse(OPEN_INPUT).success).toBe(true);
    expect(
      openCaseBodySchema.safeParse({ ...OPEN_INPUT, extra: true }).success,
    ).toBe(false);

    expect(
      recordActionBodySchema.safeParse({
        type: 'sms',
        scheduledFor: '2026-09-02T09:00:00+03:00',
      }).success,
    ).toBe(true);
    expect(
      recordActionBodySchema.safeParse({
        type: 'sms',
        scheduledFor: 'yesterday',
      }).success,
    ).toBe(false);
  });
});

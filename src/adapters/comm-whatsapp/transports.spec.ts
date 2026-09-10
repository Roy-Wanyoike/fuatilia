/**
 * Wire conformance for the Meta WhatsApp Cloud API transport (issue #128):
 * request shape (URL, headers, body), Kenya phone normalization discipline,
 * the full refusal taxonomy matrix (token failure, template rejection,
 * rate-limit 131048, outages, malformed bodies) — driven through a recorded
 * fake fetch. No network.
 */
import { describe, expect, it } from 'vitest';
import {
  maskMsisdn,
  normalizeKenyanPhone,
  whatsappBuildTemplateRequest,
  whatsappCloudTransport,
  whatsappConfigFromEnv,
  whatsappParseResponse,
  scrubLongDigitRuns,
  WA_DEFAULT_API_VERSION,
  type HttpFetch,
  type WhatsAppTemplateSend,
} from './transports';

const CONFIG = { phoneNumberId: '111111111111111', accessToken: 'wa-token', apiVersion: 'v21.0' };
const REQ: WhatsAppTemplateSend = {
  to: '+254712345678',
  templateName: 'payment_reminder_v1',
  languageCode: 'sw',
  bodyParams: ['INV-1042', 'KES 2,500'],
  clientRef: 'msg-1#1',
};

/**
 * Recorded fake fetch (the ONLY fakes allowed in this lane live in specs):
 * captures the materialized platform `Request` and answers with a real
 * `Response`. No network.
 */
const recorded = (status: number, body: string) => {
  const calls: { url: string; isPlatformRequest: boolean; headers: Record<string, string>; body: string }[] = [];
  const doFetch: HttpFetch = async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    calls.push({
      url: request.url,
      isPlatformRequest: input instanceof Request,
      headers: Object.fromEntries(new Headers(request.headers).entries()),
      body: await request.text(),
    });
    return new Response(body, { status });
  };
  return { calls, doFetch };
};

const errorBody = (code: number, message = '(#error) provider said no') =>
  JSON.stringify({
    error: { message, type: 'OAuthException', code, error_data: { messaging_product: 'whatsapp', details: message } },
    fbtrace_id: 'Az8bbbbbbbbbbbbbbbbbbb',
  });

describe('whatsappConfigFromEnv', () => {
  it('refuses missing credentials', () => {
    expect(() => whatsappConfigFromEnv(() => '')).toThrowError(/WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN/);
  });

  it('refuses when only one credential is set', () => {
    const partial = (k: string): string => (k === 'WA_PHONE_NUMBER_ID' ? '111' : '');
    expect(() => whatsappConfigFromEnv(partial)).toThrowError(/WA_CONFIG_INVALID|WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN/);
  });

  it('reads credentials from env and pins the default Graph version', () => {
    const config = whatsappConfigFromEnv((k) => (k === 'WA_PHONE_NUMBER_ID' ? '111' : k === 'WA_ACCESS_TOKEN' ? 'tok' : ''));
    expect(config).toEqual({ phoneNumberId: '111', accessToken: 'tok', apiVersion: WA_DEFAULT_API_VERSION });
  });

  it('honours an explicit WA_API_VERSION override', () => {
    const config = whatsappConfigFromEnv((k) => (k === 'WA_PHONE_NUMBER_ID' ? '111' : k === 'WA_ACCESS_TOKEN' ? 'tok' : k === 'WA_API_VERSION' ? 'v20.0' : ''));
    expect(config.apiVersion).toBe('v20.0');
  });

  it.each(['21.0', 'v21', 'v21.0.1', 'latest'])('refuses malformed WA_API_VERSION "%s"', (version) => {
    const env = (k: string): string =>
      k === 'WA_PHONE_NUMBER_ID' ? '111' : k === 'WA_ACCESS_TOKEN' ? 'tok' : k === 'WA_API_VERSION' ? version : '';
    expect(() => whatsappConfigFromEnv(env)).toThrowError(/WA_API_VERSION/);
  });
});

describe('normalizeKenyanPhone (E.164 discipline)', () => {
  it.each([
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['0712345678', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    ['254-712-345-678', '254712345678'],
    ['2540712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0111222333', '254111222333'],
    ['+254112233445', '254112233445'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each([
    ['0712345678901'], // too long
    ['071234567'], // too short
    ['254612345678'], // Kenyan landline prefix — mobile lane only
    ['441234567890'], // not Kenya
    ['abcdef'],
    ['+2547123456789'],
  ])('refuses %s', (input) => {
    expect(() => normalizeKenyanPhone(input)).toThrowError(/is not a Kenyan mobile/);
  });

  it('refuses empty input and masks numbers in refusal messages', () => {
    expect(() => normalizeKenyanPhone('')).toThrowError(/destination \*\*\*\*/);
    try {
      normalizeKenyanPhone('0712345678901');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(maskMsisdn('0712345678901'));
      expect((error as Error).message).not.toContain('0712345678901');
    }
  });
});

describe('whatsappBuildTemplateRequest (wire conformance)', () => {
  it('builds the documented request (Bearer token, JSON body, normalized wa_id)', () => {
    const { url, init } = whatsappBuildTemplateRequest(CONFIG, REQ);
    expect(url).toBe('https://graph.facebook.com/v21.0/111111111111111/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer wa-token');
    expect(init.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '254712345678',
      type: 'template',
      template: {
        name: 'payment_reminder_v1',
        language: { code: 'sw' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'INV-1042' },
              { type: 'text', text: 'KES 2,500' },
            ],
          },
        ],
      },
    });
  });

  it('omits components when the template carries no body parameters', () => {
    const { init } = whatsappBuildTemplateRequest(CONFIG, { ...REQ, bodyParams: [] });
    const payload = JSON.parse(init.body) as { template: Record<string, unknown> };
    expect(payload.template['components']).toBeUndefined();
  });

  it('refuses unfixable phones before any wire request exists', () => {
    expect(() => whatsappBuildTemplateRequest(CONFIG, { ...REQ, to: '071234567' })).toThrowError(/is not a Kenyan mobile/);
  });

  it.each([
    ['template name', { ...REQ, templateName: 'Payment Reminder' }, /must match \[a-z0-9_\]\+/],
    ['empty template name', { ...REQ, templateName: '' }, /must match \[a-z0-9_\]\+/],
    ['language code', { ...REQ, languageCode: 'en-KE' }, /must be a Meta language code/],
    ['uppercase language', { ...REQ, languageCode: 'EN' }, /must be a Meta language code/],
  ])('refuses bad %s before the wire', (_name, req, matches) => {
    expect(() => whatsappBuildTemplateRequest(CONFIG, req)).toThrowError(matches);
  });
});

describe('whatsappParseResponse (refusal taxonomy)', () => {
  const success = JSON.stringify({
    messaging_product: 'whatsapp',
    contacts: [{ input: '254712345678', wa_id: '254712345678' }],
    messages: [{ id: 'wamid.HBgLMjU0NzEyMzQ1Njc4FQIAERgSNDEAAAAAAA==' }],
  });

  it('accepts a send response and carries the wamid as providerRef', () => {
    expect(whatsappParseResponse(200, success)).toEqual({
      ok: true,
      providerRef: 'wamid.HBgLMjU0NzEyMzQ1Njc4FQIAERgSNDEAAAAAAA==',
    });
  });

  it.each([
    ['token failure (HTTP 401)', 401, errorBody(190, '(#190) Invalid OAuth access token'), 'WA_AUTH_REJECTED', false],
    ['token failure (code 190 on 400)', 400, errorBody(190, 'Error validating access token: session has expired'), 'WA_AUTH_REJECTED', false],
    ['rate limit 131048 (on 400)', 400, errorBody(131048, '(#131048) Rate limit hit'), 'WA_RATE_LIMITED', true],
    ['rate limit (HTTP 429)', 429, '{}', 'WA_RATE_LIMITED', true],
    ['template rejection (param count 132000)', 400, errorBody(132000, 'Number of parameters does not match the expected'), 'WA_TEMPLATE_REJECTED', false],
    ['template rejection (json format 132001)', 400, errorBody(132001, 'template json format error'), 'WA_TEMPLATE_REJECTED', false],
    ['window closed (re-engagement 131047)', 400, errorBody(131047, '(#131047) Re-engagement message'), 'WA_WINDOW_CLOSED', false],
    ['recipient undeliverable (131026)', 400, errorBody(131026, 'Message undeliverable'), 'WA_RECIPIENT_UNDELIVERABLE', false],
    ['unmapped business refusal (131030)', 400, errorBody(131030, 'Recipient not in allowed list'), 'WA_PROVIDER_REFUSED_131030', false],
    ['unmapped graph error (code 4)', 400, errorBody(4, 'Application request limit reached'), 'WA_PROVIDER_ERROR_4: Application request limit reached', false],
    ['graph error without a code', 400, JSON.stringify({ error: { message: 'bad request shape' } }), 'WA_PROVIDER_ERROR_0: bad request shape', false],
    ['graph error on a 2xx is still a refusal', 200, errorBody(190, 'session expired'), 'WA_AUTH_REJECTED', false],
    ['5xx outage is retryable', 503, 'upstream blew up', 'WA_PROVIDER_OUTAGE_503', true],
    ['malformed body is refused', 200, '<html>login page</html>', 'WA_WIRE_MALFORMED', false],
    ['malformed body on 4xx is flagged retryable', 400, 'nope', 'WA_WIRE_MALFORMED', true],
    ['non-object JSON is refused', 200, '[1,2,3]', 'WA_WIRE_MALFORMED', false],
    ['missing messages array is refused', 200, JSON.stringify({ contacts: [{ wa_id: '254712345678' }] }), 'WA_WIRE_MALFORMED_NO_MESSAGE_ID', false],
    ['empty messages array is refused', 200, JSON.stringify({ messages: [] }), 'WA_WIRE_MALFORMED_NO_MESSAGE_ID', false],
    ['message id of the wrong type is refused', 200, JSON.stringify({ messages: [{ id: 42 }] }), 'WA_WIRE_MALFORMED_NO_MESSAGE_ID', false],
  ])('%s', (_name, status, body, reason, retryable) => {
    const result = whatsappParseResponse(status, body);
    if (result.ok) throw new Error(`expected a refusal, got ok: ${result.providerRef}`);
    expect(result.failureReason).toBe(reason);
    expect(result.retryable).toBe(retryable);
  });

  it('scrubs long digit runs out of unmapped provider messages', () => {
    const result = whatsappParseResponse(400, errorBody(368, 'account 254712345678 temporarily blocked by policy'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureReason).toContain(scrubLongDigitRuns('254712345678'));
      expect(result.failureReason).not.toContain('254712345678');
    }
  });
});

describe('whatsappCloudTransport (injected fetch)', () => {
  it('dispatch returns the parsed outcome through the injected port', async () => {
    const success = JSON.stringify({ messages: [{ id: 'wamid.ACBO' }] });
    const { calls, doFetch } = recorded(200, success);
    const result = await whatsappCloudTransport(CONFIG, doFetch).dispatch(REQ);
    expect(result).toEqual({ ok: true, providerRef: 'wamid.ACBO' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.isPlatformRequest).toBe(true); // the fetch sees an audited platform Request
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v21.0/111111111111111/messages');
    expect(calls[0]?.headers['authorization']).toBe('Bearer wa-token');
  });

  it('network failures are retryable refusals, never throws', async () => {
    const doFetch: HttpFetch = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await whatsappCloudTransport(CONFIG, doFetch).dispatch(REQ);
    expect(result).toEqual({ ok: false, failureReason: 'WA_NETWORK_ERROR: ECONNRESET', retryable: true });
  });

  it('non-Error throwables still refuse as retryable network errors', async () => {
    const doFetch: HttpFetch = async () => {
      throw 'boom';
    };
    const result = await whatsappCloudTransport(CONFIG, doFetch).dispatch(REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureReason).toBe('WA_NETWORK_ERROR: boom');
      expect(result.retryable).toBe(true);
    }
  });

  it('a body that never resolves is a retryable refusal, never a throw', async () => {
    const doFetch: HttpFetch = async (): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('socket hang up mid-body'));
        },
      });
      return new Response(stream, { status: 200 });
    };
    const result = await whatsappCloudTransport(CONFIG, doFetch).dispatch(REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureReason).toBe('WA_NETWORK_ERROR: socket hang up mid-body');
      expect(result.retryable).toBe(true);
    }
  });
});

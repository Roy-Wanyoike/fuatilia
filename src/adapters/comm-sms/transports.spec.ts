/**
 * Wire conformance for both SMS transports (issue #112): request shape
 * (URL, headers, body), success mapping, and the full error matrix — driven
 * through a recorded fake `HttpPost`. No network.
 */
import { describe, expect, it } from 'vitest';
import {
  africasTalkingBuildRequest,
  africasTalkingConfigFromEnv,
  africasTalkingParseResponse,
  africasTalkingTransport,
  maskMsisdn,
  twilioBuildRequest,
  twilioConfigFromEnv,
  twilioParseResponse,
  twilioTransport,
  type HttpPost,
} from './transports';

const CONFIG_AT = { username: 'sandbox', apiKey: 'atk-key' };
const CONFIG_TW = { accountSid: 'AC123', authToken: 'tw-token', messagingServiceSid: 'MG123' };
const REQ = { to: '254712345678', body: 'Invoice INV-1042 is due. Pay via M-Pesa.', clientRef: 'msg-1' };

const recorded = (status: number, body: string) => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const post: HttpPost = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: init.body });
    return { status, body };
  };
  return { calls, post };
};

describe('africasTalkingConfigFromEnv', () => {
  it('refuses missing credentials', () => {
    expect(() => africasTalkingConfigFromEnv(() => '')).toThrowError(/AT_USERNAME and AT_API_KEY/);
  });
  it('reads credentials from env', () => {
    const config = africasTalkingConfigFromEnv((k) => (k === 'AT_USERNAME' ? 'u' : k === 'AT_API_KEY' ? 'k' : ''));
    expect(config).toEqual({ username: 'u', apiKey: 'k' });
  });
});

describe('africasTalking wire conformance', () => {
  it('builds the documented request (apiKey header, form body, sender id)', () => {
    const { url, init } = africasTalkingBuildRequest({ ...CONFIG_AT, senderId: 'FUATILIA' }, REQ);
    expect(url).toBe('https://api.africastalking.com/version1/messaging');
    expect(init.headers['apiKey']).toBe('atk-key');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toContain('username=sandbox');
    expect(init.body).toContain('to=254712345678');
    expect(init.body).toContain('from=FUATILIA');
  });

  it('refuses non-Kenyan destinations before any I/O', () => {
    expect(() => africasTalkingBuildRequest(CONFIG_AT, { ...REQ, to: '0712345678' })).toThrowError(/must be 2547XXXXXXXX/);
  });

  it('masks MSISDNs in refusal messages', () => {
    try {
      africasTalkingBuildRequest(CONFIG_AT, { ...REQ, to: '0712345678' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(maskMsisdn('0712345678'));
      expect((error as Error).message).not.toContain('0712345678');
    }
  });

  it('accepts a Success response and carries the messageId as providerRef', () => {
    const result = africasTalkingParseResponse(
      201,
      JSON.stringify({ SMSMessageData: { Recipients: [{ messageId: 'ATIdx_1', status: 'Success', phoneNumber: '+254712345678' }] } }),
    );
    expect(result).toEqual({ ok: true, providerRef: 'ATIdx_1' });
  });

  it.each([
    ['auth rejected is permanent', 401, '{}', 'AT_AUTH_REJECTED', false],
    ['rate limit is retryable', 429, '{}', 'AT_RATE_LIMITED', true],
    ['5xx outage is retryable', 503, '{}', 'AT_PROVIDER_OUTAGE_503', true],
    ['malformed body is refused', 200, '<html>', 'AT_WIRE_MALFORMED', false],
    ['empty recipients refused', 200, JSON.stringify({ SMSMessageData: { Recipients: [] } }), 'AT_WIRE_MALFORMED_NO_RECIPIENTS', false],
    ['per-recipient failure carries the status', 200, JSON.stringify({ SMSMessageData: { Recipients: [{ messageId: 'x', status: 'InvalidPhoneNumber' }] } }), 'AT_InvalidPhoneNumber', false],
  ])('%s', (_name, status, body, reason, retryable) => {
    expect(africasTalkingParseResponse(status, body)).toEqual({ ok: false, failureReason: reason, retryable });
  });

  it('dispatch returns the parsed outcome through the injected port', async () => {
    const { post, calls } = recorded(
      201,
      JSON.stringify({ SMSMessageData: { Recipients: [{ messageId: 'ATIdx_9', status: 'Success' }] } }),
    );
    const transport = africasTalkingTransport(CONFIG_AT, post);
    const result = await transport.dispatch(REQ);
    expect(result).toEqual({ ok: true, providerRef: 'ATIdx_9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.apiKey).toBe('atk-key');
  });

  it('network failures are retryable refusals, never throws', async () => {
    const post: HttpPost = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await africasTalkingTransport(CONFIG_AT, post).dispatch(REQ);
    expect(result).toEqual({ ok: false, failureReason: 'AT_NETWORK_ERROR: ECONNRESET', retryable: true });
  });
});

describe('twilioConfigFromEnv', () => {
  it('refuses missing credentials', () => {
    expect(() => twilioConfigFromEnv(() => '')).toThrowError(/TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
  });
});

describe('twilio wire conformance', () => {
  it('builds the documented request (basic auth, form body, messaging service)', () => {
    const { url, init } = twilioBuildRequest(CONFIG_TW, REQ);
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('AC123:tw-token').toString('base64')}`);
    expect(init.body).toContain('To=254712345678');
    expect(init.body).toContain('MessagingServiceSid=MG123');
  });

  it('refuses to build without a sender identity', () => {
    expect(() => twilioBuildRequest({ accountSid: 'AC', authToken: 't' }, REQ)).toThrowError(/From number or TWILIO_MESSAGING_SERVICE_SID/);
  });

  it('accepts a queued response and carries the sid', () => {
    expect(twilioParseResponse(201, JSON.stringify({ sid: 'SM876', status: 'queued' }))).toEqual({
      ok: true,
      providerRef: 'SM876',
    });
  });

  it.each([
    ['rate limit is retryable', 429, '{}', 'TWILIO_RATE_LIMITED', true],
    ['5xx outage is retryable', 500, '{}', 'TWILIO_PROVIDER_OUTAGE_500', true],
    ['documented 4xx is permanent', 400, JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number" }), 'TWILIO_ERROR_21211', false],
    ['malformed body is refused', 200, 'nope', 'TWILIO_WIRE_MALFORMED', false],
    ['missing sid is refused', 200, JSON.stringify({ status: 'queued' }), 'TWILIO_WIRE_MALFORMED_NO_SID', false],
    ['failed wire status is permanent', 200, JSON.stringify({ sid: 'SM1', status: 'canceled' }), 'TWILIO_CANCELED', false],
  ])('%s', (_name, status, body, reasonPrefix, retryable) => {
    const result = twilioParseResponse(status, body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureReason.startsWith(reasonPrefix) || result.failureReason === reasonPrefix).toBe(true);
      expect(result.retryable).toBe(retryable);
    }
  });

  it('network failures are retryable refusals, never throws', async () => {
    const post: HttpPost = async () => {
      throw new Error('socket hang up');
    };
    const result = await twilioTransport(CONFIG_TW, post).dispatch(REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

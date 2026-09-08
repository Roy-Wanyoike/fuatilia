/**
 * Transport ports + wire shapes for the production SMS lane (issue #112).
 *
 * The DOMAIN provider port (`MessagingProvider.send`) is synchronous-pure —
 * the domain never performs I/O. Real I/O lives in the transports below: an
 * injected `HttpPost` function performs the network call (in tests, a fake);
 * the transport builds the provider's wire request and parses its response
 * into a RESULT VALUE. The worker's wiring (documented in the README) is:
 *
 *     transport.dispatch(req) → Promise<SmsWireResult>
 *       → outcome (a `ProviderOutcome` value)
 *       → `preResolvedProvider(outcome)` satisfies `MessagingProvider`
 *       → the pure `attemptSend` machinery runs exactly as in fixtures.
 *
 * No credentials are hardcoded: config comes from the environment
 * (`africasTalkingConfigFromEnv` / `twilioConfigFromEnv`), is never logged,
 * and MSISDNs never appear unmasked in error strings.
 */
import { DomainError } from '../../domain/shared';

/** An outbound HTTP POST as the transports see it (injected; faked in tests). */
export type HttpPost = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<{ readonly status: number; readonly body: string }>;

/** One SMS to deliver — the wire-level projection of an OutboundCommand. */
export interface SmsWireRequest {
  /** E.164 destination, `2547XXXXXXXX` / `2541XXXXXXXX` (validated per transport). */
  readonly to: string;
  /** Rendered body handed to the provider. */
  readonly body: string;
  /** Sender id (AT sender name / Twilio messaging service or number). */
  readonly from?: string;
  /** Merchant-side client reference echoed by status callbacks. */
  readonly clientRef?: string;
}

/**
 * The wire outcome as a VALUE. `retryable` is transport knowledge (rate
 * limits, provider outages) carried for the caller's observability — the
 * retry DECISION stays with the domain's pure `decideRetry` policy ladder.
 */
export type SmsWireResult =
  | { readonly ok: true; readonly providerRef: string }
  | { readonly ok: false; readonly failureReason: string; readonly retryable: boolean };

export interface SmsTransport {
  readonly name: 'africastalking' | 'twilio';
  dispatch(req: SmsWireRequest): Promise<SmsWireResult>;
}

/** Form-encode pairs without URLSearchParams (the ambient node surface is minimal by design). */
const formEncode = (pairs: readonly (readonly [string, string])[]): string =>
  pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const KENYAN_MSISDN = /^254[17]\d{8}$/;

/** Shared MSISDN validation — refuse, never normalize (normalization is the domain's job). */
export const assertKenyanMsisdn = (msisdn: string): void => {
  if (!KENYAN_MSISDN.test(msisdn)) {
    // masked — never a full number in an error string
    throw new DomainError('SMS_MSISDN_MALFORMED', `destination ${maskMsisdn(msisdn)} must be 2547XXXXXXXX / 2541XXXXXXXX`);
  }
};

/** Mask to the last 4 digits for logs and error strings. */
export const maskMsisdn = (msisdn: string): string =>
  msisdn.length <= 4 ? '****' : `****${msisdn.slice(-4)}`;

// --- Africa's Talking -----------------------------------------------------------

/** Africa's Talking config from the environment (never logged, never literal). */
export interface AfricasTalkingConfig {
  readonly username: string;
  readonly apiKey: string;
  /** Optional alphanum sender name (registered short code / sender id). */
  readonly senderId?: string;
}

export const africasTalkingConfigFromEnv = (env: (key: string) => string): AfricasTalkingConfig => {
  const username = env('AT_USERNAME')?.trim() ?? '';
  const apiKey = env('AT_API_KEY')?.trim() ?? '';
  const senderId = env('AT_SENDER_ID')?.trim() ?? '';
  if (username === '' || apiKey === '') {
    throw new DomainError('SMS_CONFIG_INVALID', 'AT_USERNAME and AT_API_KEY are required (env-injected, never hardcoded)');
  }
  return senderId === '' ? { username, apiKey } : { username, apiKey, senderId };
};

/** Africa's Talking sandbox/production root (override via AT_BASE_URL in wiring). */
export const AT_DEFAULT_BASE_URL = 'https://api.africastalking.com';

/**
 * Build the AT messaging request. Wire contract (api.africastalking.com/v1/messaging):
 * `apiKey` header + form-encoded body (username, to, message, [from]).
 */
export const africasTalkingBuildRequest = (
  config: AfricasTalkingConfig,
  req: SmsWireRequest,
): { readonly url: string; readonly init: { readonly headers: Readonly<Record<string, string>>; readonly body: string } } => {
  assertKenyanMsisdn(req.to);
  const pairs: (readonly [string, string])[] = [
    ['username', config.username],
    ['to', req.to],
    ['message', req.body],
  ];
  const from = req.from ?? config.senderId;
  if (from !== undefined && from !== '') pairs.push(['from', from]);
  return {
    url: `${AT_DEFAULT_BASE_URL}/version1/messaging`,
    init: {
      headers: {
        apiKey: config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formEncode(pairs),
    },
  };
};

/**
 * Parse AT's response. Success: `SMSMessageData.Recipients[]` with a
 * `messageId` and a per-recipient `status` — the FIRST recipient is ours
 * (one recipient per dispatch). Any non-Success status, a 401/429/5xx, or a
 * malformed body maps to a typed refusal.
 */
export const africasTalkingParseResponse = (status: number, body: string): SmsWireResult => {
  if (status === 401) {
    return { ok: false, failureReason: 'AT_AUTH_REJECTED', retryable: false };
  }
  if (status === 429) {
    return { ok: false, failureReason: 'AT_RATE_LIMITED', retryable: true };
  }
  if (status >= 500) {
    return { ok: false, failureReason: `AT_PROVIDER_OUTAGE_${status}`, retryable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, failureReason: 'AT_WIRE_MALFORMED', retryable: status >= 400 };
  }
  const recipients = (
    parsed as { SMSMessageData?: { Recipients?: readonly { messageId?: unknown; status?: unknown }[] } } | null
  )?.SMSMessageData?.Recipients;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { ok: false, failureReason: 'AT_WIRE_MALFORMED_NO_RECIPIENTS', retryable: false };
  }
  const first = recipients[0];
  if (typeof first?.messageId !== 'string' || first.messageId === '') {
    return { ok: false, failureReason: 'AT_WIRE_MALFORMED_NO_MESSAGE_ID', retryable: false };
  }
  const wireStatus = typeof first?.status === 'string' ? first.status : '';
  if (wireStatus !== 'Success') {
    // e.g. InvalidPhoneNumber, UserInBlackList, NotEnoughBalance — per-recipient refusal
    return { ok: false, failureReason: `AT_${wireStatus || 'UNKNOWN_STATUS'}`, retryable: false };
  }
  return { ok: true, providerRef: first.messageId };
};

/** The Africa's Talking transport over the injected HTTP port. */
export const africasTalkingTransport = (config: AfricasTalkingConfig, post: HttpPost): SmsTransport => ({
  name: 'africastalking',
  async dispatch(req: SmsWireRequest): Promise<SmsWireResult> {
    const { url, init } = africasTalkingBuildRequest(config, req);
    try {
      const res = await post(url, init);
      return africasTalkingParseResponse(res.status, res.body);
    } catch (error: unknown) {
      return {
        ok: false,
        failureReason: `AT_NETWORK_ERROR: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  },
});

// --- Twilio ---------------------------------------------------------------------

/** Twilio config from the environment (never logged, never literal). */
export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  /** Messaging service sid (preferred) or a sending number. */
  readonly messagingServiceSid?: string;
}

export const twilioConfigFromEnv = (env: (key: string) => string): TwilioConfig => {
  const accountSid = env('TWILIO_ACCOUNT_SID')?.trim() ?? '';
  const authToken = env('TWILIO_AUTH_TOKEN')?.trim() ?? '';
  const messagingServiceSid = env('TWILIO_MESSAGING_SERVICE_SID')?.trim() ?? '';
  if (accountSid === '' || authToken === '') {
    throw new DomainError('SMS_CONFIG_INVALID', 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required (env-injected, never hardcoded)');
  }
  return messagingServiceSid === '' ? { accountSid, authToken } : { accountSid, authToken, messagingServiceSid };
};

export const TWILIO_DEFAULT_BASE_URL = 'https://api.twilio.com';

/**
 * Build the Twilio request. Wire contract: POST
 * /2010-04-01/Accounts/{AccountSid}/Messages.json with HTTP Basic auth and a
 * form-encoded body (To, Body, From | MessagingServiceSid).
 */
export const twilioBuildRequest = (
  config: TwilioConfig,
  req: SmsWireRequest,
): { readonly url: string; readonly init: { readonly headers: Readonly<Record<string, string>>; readonly body: string } } => {
  assertKenyanMsisdn(req.to);
  const from = req.from ?? config.messagingServiceSid;
  if (from === undefined || from === '') {
    throw new DomainError('SMS_CONFIG_INVALID', 'twilio needs a From number or TWILIO_MESSAGING_SERVICE_SID');
  }
  return {
    url: `${TWILIO_DEFAULT_BASE_URL}/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    init: {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formEncode([
        ['To', req.to],
        ['Body', req.body],
        ['MessagingServiceSid', from],
      ]),
    },
  };
};

/**
 * Parse Twilio's response. Success = JSON with a `sid` and an accepted
 * status (queued/accepted/sent). Documented Twilio error codes map to typed
 * refusals; 429 and 5xx are retryable, 4xx business errors are not.
 */
export const twilioParseResponse = (status: number, body: string): SmsWireResult => {
  if (status === 429) {
    return { ok: false, failureReason: 'TWILIO_RATE_LIMITED', retryable: true };
  }
  if (status >= 500) {
    return { ok: false, failureReason: `TWILIO_PROVIDER_OUTAGE_${status}`, retryable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, failureReason: 'TWILIO_WIRE_MALFORMED', retryable: status >= 400 };
  }
  const record = parsed as { sid?: unknown; status?: unknown; code?: unknown; message?: unknown } | null;
  if (status >= 400) {
    const code = typeof record?.code === 'number' ? record.code : 0;
    const message = typeof record?.message === 'string' ? record.message : 'unknown Twilio error';
    return { ok: false, failureReason: `TWILIO_ERROR_${code}: ${message}`, retryable: false };
  }
  if (typeof record?.sid !== 'string' || record.sid === '') {
    return { ok: false, failureReason: 'TWILIO_WIRE_MALFORMED_NO_SID', retryable: false };
  }
  const wireStatus = typeof record?.status === 'string' ? record.status : 'queued';
  if (!(wireStatus === 'queued' || wireStatus === 'accepted' || wireStatus === 'sent')) {
    return { ok: false, failureReason: `TWILIO_${wireStatus.toUpperCase()}`, retryable: false };
  }
  return { ok: true, providerRef: record.sid };
};

/** The Twilio transport over the injected HTTP port. */
export const twilioTransport = (config: TwilioConfig, post: HttpPost): SmsTransport => ({
  name: 'twilio',
  async dispatch(req: SmsWireRequest): Promise<SmsWireResult> {
    const { url, init } = twilioBuildRequest(config, req);
    try {
      const res = await post(url, init);
      return twilioParseResponse(res.status, res.body);
    } catch (error: unknown) {
      return {
        ok: false,
        failureReason: `TWILIO_NETWORK_ERROR: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  },
});

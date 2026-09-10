/**
 * Transport port + wire shapes for the WhatsApp Cloud API lane (issue #128).
 *
 * Mirrors `../comm-sms/transports.ts` exactly: the DOMAIN provider port
 * (`MessagingProvider.send`) is synchronous-pure — the domain never performs
 * I/O. Real I/O lives here: an INJECTED `HttpFetch` (the global fetch type)
 * performs the network call (in tests, a fake); the transport builds Meta's
 * wire request and parses the response into a RESULT VALUE. The worker's
 * wiring (documented in the README) is:
 *
 *     transport.dispatch(req) → Promise<WhatsAppWireResult>
 *       → outcome (a `ProviderOutcome` value)
 *       → `preResolvedProvider(outcome)` satisfies `MessagingProvider`
 *       → the pure `attemptSend` machinery runs exactly as in fixtures.
 *
 * Untrusted-input boundary (issue #128 AC1): anything the CLOUD API returns
 * is untrusted — malformed bodies and undocumented fields map to STRUCTURED
 * refusals (`WhatsAppWireResult`), never throws. Only pre-I/O input
 * validation (unfixable phone numbers, template name/language shape) throws
 * the domain's `DomainError`, mirroring the SMS lane's "refuse before any
 * wire" discipline.
 *
 * Credentials are env-only (`whatsappConfigFromEnv`): never hardcoded, never
 * logged, never echoed; MSISDNs never appear unmasked in error strings.
 */
import { DomainError } from '../../domain/shared';

/**
 * The injected HTTP dependency — LITERALLY the global fetch type (`typeof
 * fetch`, Node ≥18). Injected, never called as a global inside this lane, so
 * tests drive the wire with recorded fakes and production wiring passes
 * `globalThis.fetch` (or any compatible impl) at the edge. The transport
 * hands the fetch a platform `Request` (see `whatsappCloudTransport`), which
 * is the Wintercg-standard input shape this port type accepts.
 */
export type HttpFetch = typeof fetch;

/**
 * The wire outcome as a VALUE (same shape as the SMS lane's `SmsWireResult`).
 * `retryable` is transport knowledge (rate limits, provider outages) carried
 * for the caller's observability — the retry DECISION stays with the domain's
 * pure `decideRetry` policy ladder.
 */
export type WhatsAppWireResult =
  | { readonly ok: true; readonly providerRef: string }
  | { readonly ok: false; readonly failureReason: string; readonly retryable: boolean };

export interface WhatsAppTransport {
  readonly name: 'whatsapp';
  dispatch(req: WhatsAppTemplateSend): Promise<WhatsAppWireResult>;
}

/**
 * One outbound WhatsApp TEMPLATE message — the wire-level projection of an
 * OutboundCommand. Business-initiated collections messages REQUIRE a
 * pre-approved Meta template (there is no free-text mode outside the 24h
 * customer-service window), so this lane is template-only by design.
 */
export interface WhatsAppTemplateSend {
  /**
   * Destination, UNTRUSTED raw input: accepted Kenyan formats are normalized
   * to the E.164 wa_id Meta requires (`2547XXXXXXXX` / `2541XXXXXXXX`, no
   * plus sign) at the build boundary.
   */
  readonly to: string;
  /** Meta-approved template name (lowercase letters, digits, underscores). */
  readonly templateName: string;
  /** Meta language code for the pinned template translation, e.g. 'en' | 'sw'. */
  readonly languageCode: string;
  /** Positional body parameters (`{{1}}`..`{{n}}`), in template order. */
  readonly bodyParams: readonly string[];
  /** Merchant-side client reference `<messageId>#<attemptNo>` (idempotency). */
  readonly clientRef?: string;
}

/** Meta Graph API root (Cloud API lives under graph.facebook.com). */
export const META_GRAPH_DEFAULT_BASE_URL = 'https://graph.facebook.com';

/** Default Graph API version used when WA_API_VERSION is unset. */
export const WA_DEFAULT_API_VERSION = 'v21.0';

/** Mask to the last 4 digits for logs and error strings (SMS-lane discipline). */
export const maskMsisdn = (msisdn: string): string =>
  msisdn.length <= 4 ? '****' : `****${msisdn.slice(-4)}`;

const E164_KENYAN_WA_ID = /^254[17]\d{8}$/;

/**
 * Normalize a Kenyan phone to the E.164 wa_id the Cloud API expects
 * (`2547XXXXXXXX` / `2541XXXXXXXX`, no plus sign). Accepted input formats:
 * `+254712345678`, `254712345678`, `2540712345678` (trunk zero after the
 * country code), `0712345678` (local), `712345678` (bare national number),
 * with the usual ` `, `-`, `(`, `)`, `.` separators. Anything that cannot be
 * normalized into a Kenyan mobile wa_id is REFUSED — masked, never echoed.
 */
export const normalizeKenyanPhone = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new DomainError('WA_MSISDN_MALFORMED', `destination ${maskMsisdn('')} is not a Kenyan mobile (+254 7XX / +254 1XX)`);
  }
  const digits = trimmed.replace(/\D+/g, '');
  let candidate: string;
  if (digits.startsWith('254')) {
    candidate = digits.startsWith('2540') ? `254${digits.slice(4)}` : digits;
  } else if (digits.startsWith('0')) {
    candidate = `254${digits.slice(1)}`;
  } else if (digits.length === 9 && (digits.startsWith('7') || digits.startsWith('1'))) {
    candidate = `254${digits}`;
  } else {
    candidate = digits;
  }
  if (!E164_KENYAN_WA_ID.test(candidate)) {
    // masked — never a full number in an error string
    throw new DomainError(
      'WA_MSISDN_MALFORMED',
      `destination ${maskMsisdn(trimmed)} is not a Kenyan mobile (+254 7XX / +254 1XX)`,
    );
  }
  return candidate;
};

/** Meta template names: lowercase letters, digits, underscores. */
const TEMPLATE_NAME = /^[a-z0-9_]+$/;

const assertTemplateName = (name: string): void => {
  if (!TEMPLATE_NAME.test(name)) {
    throw new DomainError('WA_TEMPLATE_NAME_INVALID', `template name "${name}" must match [a-z0-9_]+ (Meta naming rules)`);
  }
};

/** Meta language codes: `en`, `sw`, `en_US`, `es_AR` … */
const LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const assertLanguageCode = (code: string): void => {
  if (!LANGUAGE_CODE.test(code)) {
    throw new DomainError('WA_TEMPLATE_LANGUAGE_INVALID', `template language "${code}" must be a Meta language code (e.g. 'en' | 'sw' | 'en_US')`);
  }
};

/** Meta Cloud API config from the environment (never logged, never literal). */
export interface WhatsAppCloudConfig {
  /** The sending phone number id from the WhatsApp Business Account. */
  readonly phoneNumberId: string;
  /** Bearer token (system-user access token). Token comes from env ONLY. */
  readonly accessToken: string;
  /** Graph API version, e.g. 'v21.0' (WA_API_VERSION; default pinned above). */
  readonly apiVersion: string;
}

const GRAPH_VERSION = /^v\d+\.\d+$/;

export const whatsappConfigFromEnv = (env: (key: string) => string): WhatsAppCloudConfig => {
  const phoneNumberId = env('WA_PHONE_NUMBER_ID')?.trim() ?? '';
  const accessToken = env('WA_ACCESS_TOKEN')?.trim() ?? '';
  const apiVersion = env('WA_API_VERSION')?.trim() ?? '';
  if (phoneNumberId === '' || accessToken === '') {
    throw new DomainError('WA_CONFIG_INVALID', 'WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN are required (env-injected, never hardcoded)');
  }
  if (apiVersion !== '' && !GRAPH_VERSION.test(apiVersion)) {
    throw new DomainError('WA_CONFIG_INVALID', `WA_API_VERSION "${apiVersion}" must look like 'v21.0'`);
  }
  return { phoneNumberId, accessToken, apiVersion: apiVersion === '' ? WA_DEFAULT_API_VERSION : apiVersion };
};

/** URL-shaped request ready for the injected fetch. */
export interface WhatsAppBuildRequest {
  readonly url: string;
  readonly init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

/**
 * Build the Cloud API template-send request. Wire contract: POST
 * `{graph}/{version}/{phone-number-id}/messages` with a Bearer token and a
 * JSON body (`messaging_product: 'whatsapp'`, `type: 'template'`,
 * positional body parameters). The phone is normalized here — the wa_id on
 * the wire is always canonical E.164 without a plus sign.
 */
export const whatsappBuildTemplateRequest = (
  config: WhatsAppCloudConfig,
  req: WhatsAppTemplateSend,
): WhatsAppBuildRequest => {
  const waId = normalizeKenyanPhone(req.to); // pre-I/O refusal for unfixable input
  assertTemplateName(req.templateName);
  assertLanguageCode(req.languageCode);
  const template: Record<string, unknown> = {
    name: req.templateName,
    language: { code: req.languageCode },
  };
  if (req.bodyParams.length > 0) {
    template['components'] = [
      {
        type: 'body',
        parameters: req.bodyParams.map((text) => ({ type: 'text', text })),
      },
    ];
  }
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waId,
    type: 'template',
    template,
  };
  return {
    url: `${META_GRAPH_DEFAULT_BASE_URL}/${config.apiVersion}/${config.phoneNumberId}/messages`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    },
  };
};

// --- refusal taxonomy (one classifier for send-time AND receipt-time errors) ----

export interface ErrorTaxon {
  /** Stable `WA_*` refusal code — the machine-readable taxonomy. */
  readonly reason: string;
  /** Transport knowledge: may a retry with identical input succeed? */
  readonly retryable: boolean;
}

/**
 * Documented Meta Cloud API error codes → refusal taxonomy. Status-level
 * signals (401/429/5xx) are classified BEFORE the body is trusted; these
 * code-level rows apply to the Graph error envelope:
 *   - 190     — token invalid/expired (also arrives with HTTP 400);
 *   - 131048  — rate limit hit (the documented spam-rate-limit throttle);
 *   - 131047  — re-engagement / 24h customer-service window policy;
 *   - 131026  — message undeliverable for this recipient;
 *   - 132000/132001 — template param/JSON rejected (template refusal).
 */
const PROVIDER_ERROR_TAXONOMY: ReadonlyMap<number, ErrorTaxon> = new Map([
  [190, { reason: 'WA_AUTH_REJECTED', retryable: false }],
  [131047, { reason: 'WA_WINDOW_CLOSED', retryable: false }],
  [131048, { reason: 'WA_RATE_LIMITED', retryable: true }],
  [131026, { reason: 'WA_RECIPIENT_UNDELIVERABLE', retryable: false }],
  [132000, { reason: 'WA_TEMPLATE_REJECTED', retryable: false }],
  [132001, { reason: 'WA_TEMPLATE_REJECTED', retryable: false }],
]);

/**
 * Meta error messages can embed the recipient's number — scrub long digit
 * runs so refusals never carry full MSISDNs (SMS-lane discipline).
 */
export const scrubLongDigitRuns = (text: string): string => text.replace(/\d{6,}/g, '****');

const classifyProviderError = (code: number, message: string): ErrorTaxon => {
  const known = PROVIDER_ERROR_TAXONOMY.get(code);
  if (known !== undefined) return known;
  if (code >= 131000 && code <= 139999) {
    return { reason: `WA_PROVIDER_REFUSED_${code}`, retryable: false };
  }
  const detail = message.trim() === '' ? '' : `: ${scrubLongDigitRuns(message)}`;
  return { reason: `WA_PROVIDER_ERROR_${code}${detail}`, retryable: false };
};

// --- response parsing (the untrusted-input boundary) ----------------------------

/**
 * Parse the Cloud API send response. Success = JSON carrying
 * `messages[0].id` (the `wamid.…` provider ref). Every failure maps to a
 * STRUCTURED refusal — status-level signals first (401/429/5xx), then the
 * Graph error envelope by documented code, then shape validation. Malformed
 * bodies never throw.
 */
export const whatsappParseResponse = (status: number, body: string): WhatsAppWireResult => {
  if (status === 401) {
    return { ok: false, failureReason: 'WA_AUTH_REJECTED', retryable: false };
  }
  if (status === 429) {
    return { ok: false, failureReason: 'WA_RATE_LIMITED', retryable: true };
  }
  if (status >= 500) {
    return { ok: false, failureReason: `WA_PROVIDER_OUTAGE_${status}`, retryable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, failureReason: 'WA_WIRE_MALFORMED', retryable: status >= 400 };
  }
  const record = asRecord(parsed);
  if (record === null) {
    return { ok: false, failureReason: 'WA_WIRE_MALFORMED', retryable: status >= 400 };
  }
  const error = asRecord(record['error']);
  if (error !== null) {
    const code = typeof error['code'] === 'number' ? error['code'] : 0;
    const message = typeof error['message'] === 'string' ? error['message'] : '';
    const taxon = classifyProviderError(code, message);
    return { ok: false, failureReason: taxon.reason, retryable: taxon.retryable };
  }
  const messages = record['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, failureReason: 'WA_WIRE_MALFORMED_NO_MESSAGE_ID', retryable: false };
  }
  const first = asRecord(messages[0]);
  const id = first?.['id'];
  if (typeof id !== 'string' || id === '') {
    return { ok: false, failureReason: 'WA_WIRE_MALFORMED_NO_MESSAGE_ID', retryable: false };
  }
  return { ok: true, providerRef: id };
};

const asRecord = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
};

/**
 * The Meta Cloud API transport over the injected fetch port. The built
 * `{ url, init }` is materialized into a platform `Request` so the injected
 * fetch executes exactly the audited wire shape (and so the call resolves
 * against the platform fetch signature, not any narrower ambient view).
 * Every failure after the build is a STRUCTURED refusal — network faults and
 * unreadable bodies included; dispatch never throws once the input passed.
 */
export const whatsappCloudTransport = (config: WhatsAppCloudConfig, doFetch: HttpFetch): WhatsAppTransport => ({
  name: 'whatsapp',
  async dispatch(req: WhatsAppTemplateSend): Promise<WhatsAppWireResult> {
    const { url, init } = whatsappBuildTemplateRequest(config, req);
    try {
      const res = await doFetch(new Request(url, init));
      const body = await res.text();
      return whatsappParseResponse(res.status, body);
    } catch (error: unknown) {
      return {
        ok: false,
        failureReason: `WA_NETWORK_ERROR: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    }
  },
});

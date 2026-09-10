/**
 * Transport port + wire shapes for the production EMAIL lane (issue #127).
 *
 * Mirrors `src/adapters/comm-sms/transports.ts` exactly: the DOMAIN provider
 * port (`MessagingProvider.send`) is synchronous-pure — the domain never
 * performs I/O. Real I/O lives behind an injected transport: an injected
 * `SmtpDeliver` function performs the SMTP conversation against the relay
 * (in tests, a fake); the transport builds the RFC 5322 / MIME message,
 * validates the envelope, and classifies the relay's final reply into a
 * RESULT VALUE. The worker's wiring (documented in the README) is:
 *
 *     transport.dispatch(req) → Promise<EmailWireResult>
 *       → outcome (a `ProviderOutcome` value)
 *       → `preResolvedProvider(outcome)` satisfies `MessagingProvider`
 *       → the pure `attemptSend` machinery runs exactly as in fixtures.
 *
 * No credentials are hardcoded: config comes from the environment
 * (`smtpConfigFromEnv`), is never logged, and email addresses never appear
 * with their local part in error strings (redaction-safe metadata). The
 * nodemailer dependency is deliberately NOT added (justified in README.md):
 * the socket-level SMTP client is edge wiring behind `SmtpDeliver`, exactly
 * like the HTTP client behind comm-sms's `HttpPost`.
 */
import { DomainError, type Clock } from '../../domain/shared';

/**
 * One authenticated SMTP send as the transports see it (injected; faked in
 * tests). `envelope` is the SMTP MAIL FROM / RCPT TO pair; `data` is the
 * finished RFC 5322 message (CRLF line endings). The reply is the relay's
 * FINAL reply to the DATA transaction — a 2xx code means accepted-for-relay.
 * The port is constructed against an already-configured session (host/port/
 * credentials resolved at the edge from env); it NEVER receives credentials
 * per call.
 */
export type SmtpDeliver = (
  envelope: { readonly from: string; readonly to: string },
  data: string,
) => Promise<{ readonly code: number; readonly message: string }>;

/** One email to deliver — the wire-level projection of an OutboundCommand. */
export interface EmailWireRequest {
  /** Bare recipient address (RFC 5322 dot-atom local + fqdn; validated). */
  readonly to: string;
  /** Subject line (header-injection guarded; RFC 2047-encoded when non-ASCII). */
  readonly subject: string;
  /** Rendered plain-text body handed to the provider (base64 MIME part). */
  readonly text: string;
  /** Optional HTML alternative (base64 MIME part; multipart/alternative). */
  readonly html?: string;
  /** Per-message sender override (defaults to the config's verified sender). */
  readonly from?: string;
  /**
   * Merchant-side client reference (`"<messageId>#<attemptNo>"`) — REQUIRED
   * for email (unlike SMS) because the Message-ID header is derived from it:
   * an SMTP acceptance carries no provider-issued id, so the Message-ID we
   * generate IS the trackable reference.
   */
  readonly clientRef: string;
}

/**
 * The wire outcome as a VALUE. `retryable` is transport knowledge (grey-
 * temping 4xx, relay outages) carried for the caller's observability — the
 * retry DECISION stays with the domain's pure `decideRetry` policy ladder.
 */
export type EmailWireResult =
  | { readonly ok: true; readonly providerRef: string }
  | { readonly ok: false; readonly failureReason: string; readonly retryable: boolean };

export interface EmailTransport {
  readonly name: 'smtp';
  dispatch(req: EmailWireRequest): Promise<EmailWireResult>;
}

// --- address validation + redaction (untrusted-input discipline) -------------

/** Mask the local part for logs and error strings — metadata stays safe. */
export const maskEmail = (address: string): string => {
  const at = address.indexOf('@');
  if (at === -1) return '****';
  return `****@${address.slice(at + 1)}`;
};

/** RFC 5322 dot-atom: atext runs joined by single dots (quoted forms refused). */
const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** RFC 1035 label: alnum, interior hyphens, 1..63 chars. */
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Validate a domain (labels + fqdn shape) — shared by addresses and config. */
export const assertEmailDomain = (domain: string, field: string): void => {
  if (domain === '' || domain.length > 255) {
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} is not a valid domain`);
  }
  const labels = domain.split('.');
  if (labels.length < 2) {
    // fqdn required for an outbound dunning rail — refuse, never normalize
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} "${domain}" must be fully qualified`);
  }
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) {
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} "${domain}" has a malformed label`);
  }
};

/**
 * Shared address validation — refuse, never normalize (normalization is the
 * domain's job). Bare addresses only: display-name forms and quoted local
 * parts are legal RFC 5322 but a hostile-input surface this rail refuses.
 * The error string carries the MASKED address, never the local part.
 */
export const assertEmailAddress = (address: string, field: string): void => {
  if (address.length > 254) {
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} exceeds 254 characters (${maskEmail(address)})`);
  }
  const at = address.indexOf('@');
  if (at === -1) {
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} ${maskEmail(address)} must be a bare address like local@domain`);
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (address.indexOf('@', at + 1) !== -1 || local === '' || local.length > 64 || !DOT_ATOM.test(local)) {
    throw new DomainError('EMAIL_ADDRESS_MALFORMED', `${field} ${maskEmail(address)} has a malformed local part`);
  }
  assertEmailDomain(domain, field);
};

/**
 * Header-injection guard for any header value built from request fields
 * (subject, sender overrides). CR/LF would smuggle extra headers — refuse
 * WITHOUT echoing the untrusted value back.
 */
export const assertHeaderSafe = (value: string, field: string): void => {
  if (/[\r\n]/.test(value)) {
    throw new DomainError('EMAIL_HEADER_UNSAFE', `${field} contains CR/LF control characters — header injection refused`);
  }
};

// --- config (env-only credentials) ---------------------------------------------

/** Relay + sender identity config (never logged, never a literal). */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** The org's verified sender (envelope + From header default). */
  readonly from: string;
  /** Message-ID domain override (defaults to the domain of `from`). */
  readonly relayDomain?: string;
  /** Relay credentials — consumed by the edge session factory, never by codecs. */
  readonly username?: string;
  readonly password?: string;
}

export const SMTP_DEFAULT_PORT = 587;

export const smtpConfigFromEnv = (env: (key: string) => string): SmtpConfig => {
  const host = env('SMTP_HOST')?.trim() ?? '';
  const from = env('SMTP_FROM')?.trim() ?? '';
  if (host === '') {
    throw new DomainError('EMAIL_CONFIG_INVALID', 'SMTP_HOST is required (env-injected, never hardcoded)');
  }
  if (from === '') {
    throw new DomainError('EMAIL_CONFIG_INVALID', 'SMTP_FROM is required (env-injected, never hardcoded)');
  }
  assertEmailAddress(from, 'SMTP_FROM');
  const rawPort = env('SMTP_PORT')?.trim() ?? '';
  let port = SMTP_DEFAULT_PORT;
  if (rawPort !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new DomainError('EMAIL_CONFIG_INVALID', `SMTP_PORT must be an integer 1..65535, got "${rawPort}"`);
    }
    port = parsed;
  }
  const relayDomain = env('SMTP_RELAY_DOMAIN')?.trim() ?? '';
  if (relayDomain !== '') assertEmailDomain(relayDomain, 'SMTP_RELAY_DOMAIN');
  const username = env('SMTP_USERNAME')?.trim() ?? '';
  const password = env('SMTP_PASSWORD')?.trim() ?? '';
  if ((username === '') !== (password === '')) {
    throw new DomainError('EMAIL_CONFIG_INVALID', 'SMTP_USERNAME and SMTP_PASSWORD must be set together (env-injected, never hardcoded)');
  }
  return {
    host,
    port,
    from,
    ...(relayDomain !== '' ? { relayDomain } : {}),
    ...(username !== '' ? { username, password } : {}),
  };
};

// --- pure codecs ------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * RFC 5322 §3.3 date-time, always UTC (+0000) — deterministic and unambiguous
 * regardless of host timezone. Built from the fixed day/month tables over the
 * UTC getters.
 */
export const buildRfc5322Date = (at: Date): string => {
  const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
  const day = DAYS[at.getUTCDay()];
  const month = MONTHS[at.getUTCMonth()];
  if (day === undefined || month === undefined || Number.isNaN(at.getTime())) {
    throw new DomainError('EMAIL_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return `${day}, ${pad2(at.getUTCDate())} ${month} ${at.getUTCFullYear()} ${pad2(at.getUTCHours())}:${pad2(
    at.getUTCMinutes(),
  )}:${pad2(at.getUTCSeconds())} +0000`;
};

/** Reduce a clientRef to RFC 5322 atext (dot-atom) for the Message-ID id-left. */
const sanitizeIdLeft = (clientRef: string): string =>
  clientRef
    .replace(/[^A-Za-z0-9.-]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');

/** RFC 2045 base64, wrapped at 76 chars with CRLF (the wire contract). */
const base64Wrapped = (input: string): string => {
  const raw = Buffer.from(input, 'utf8').toString('base64');
  return (raw.match(/.{1,76}/g) ?? []).join('\r\n');
};

/** RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through. */
const encodeSubject = (subject: string): string =>
  /^[\x20-\x7E]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

const domainOf = (address: string): string => address.slice(address.indexOf('@') + 1);

export interface SmtpBuiltMessage {
  /** MAIL FROM / RCPT TO pair — what the relay enforces. */
  readonly envelope: { readonly from: string; readonly to: string };
  /** The finished RFC 5322 message (CRLF line endings, base64 body parts). */
  readonly data: string;
  /** The bracketed Message-ID header — the providerRef on acceptance. */
  readonly messageIdHeader: string;
}

/**
 * Build the RFC 5322 / MIME message. Deterministic under the injected Clock
 * (Date header + Message-ID). Recipients, sender override and subject are
 * treated as UNTRUSTED: validated, header-injection-guarded, base64-encoded
 * into the body (so body content can never forge headers). Credentials are
 * never read here — config.username/password are the edge session's concern.
 */
export const smtpBuildMessage = (
  config: SmtpConfig,
  req: EmailWireRequest,
  clock: Clock,
): SmtpBuiltMessage => {
  const from = req.from ?? config.from;
  assertEmailAddress(from, 'from');
  assertEmailAddress(req.to, 'to');
  assertHeaderSafe(req.subject, 'subject');
  if (req.subject.trim() === '') {
    throw new DomainError('EMAIL_SUBJECT_REQUIRED', 'a dunning email requires a subject — refuse, never send headless mail');
  }
  if (req.clientRef.trim() === '') {
    throw new DomainError('EMAIL_CLIENT_REF_REQUIRED', 'a dispatch without a clientRef cannot carry a Message-ID — refuse, never guess');
  }
  if (config.relayDomain !== undefined) assertEmailDomain(config.relayDomain, 'relay domain');

  const at = clock.now();
  if (Number.isNaN(at.getTime())) {
    throw new DomainError('EMAIL_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  const relayDomain = config.relayDomain ?? domainOf(from);
  const idLeft = `${sanitizeIdLeft(req.clientRef)}.${at.getTime()}`;
  const messageIdHeader = `<${idLeft}@${relayDomain}>`;
  const crlf = '\r\n';

  const headers = [
    `From: ${from}`,
    `To: ${req.to}`,
    `Subject: ${encodeSubject(req.subject)}`,
    `Date: ${buildRfc5322Date(at)}`,
    `Message-ID: ${messageIdHeader}`,
    'MIME-Version: 1.0',
  ];

  const bodyText = base64Wrapped(req.text);
  if (req.html === undefined) {
    const data = `${headers.join(crlf)}${crlf}Content-Type: text/plain; charset=utf-8${crlf}Content-Transfer-Encoding: base64${crlf}${crlf}${bodyText}${crlf}`;
    return { envelope: { from, to: req.to }, data, messageIdHeader };
  }

  // multipart/alternative — the boundary is quoted and drawn from the
  // sanitized clientRef: the base64 alphabet has no `-`, so a body line can
  // never collide with a `--boundary` line.
  const boundary = `=_fuatilia_${sanitizeIdLeft(req.clientRef)}`;
  const bodyHtml = base64Wrapped(req.html);
  const data = [
    headers.join(crlf),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyText,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyHtml,
    `--${boundary}--`,
    '',
  ].join(crlf);
  return { envelope: { from, to: req.to }, data, messageIdHeader };
};

/**
 * Classify the relay's final reply. 2xx = accepted (providerRef is the
 * Message-ID we generated — the handle relays and DSNs echo back). 4xx =
 * transient (greylisting, deferred queueing). 5xx = permanent refusal
 * (unknown recipient, policy rejection). A reply outside the SMTP code
 * space means the session broke — treated as transient, never silent.
 */
export const smtpParseResponse = (
  reply: { readonly code: number; readonly message: string },
  messageIdHeader: string,
): EmailWireResult => {
  if (typeof reply.code !== 'number' || !Number.isInteger(reply.code) || reply.code < 200 || reply.code > 599) {
    return { ok: false, failureReason: 'EMAIL_SMTP_REPLY_MALFORMED', retryable: true };
  }
  if (reply.code < 300) {
    return { ok: true, providerRef: messageIdHeader };
  }
  // redaction-safe metadata: the banner is truncated so a chatty relay cannot
  // flood the audit trail (relay text never contains our credentials).
  const detail = reply.message.trim().slice(0, 200);
  return {
    ok: false,
    failureReason: `EMAIL_SMTP_${reply.code}: ${detail === '' ? 'no detail from relay' : detail}`,
    retryable: reply.code < 500,
  };
};

/** The SMTP transport over the injected deliver port. */
export const smtpTransport = (
  config: SmtpConfig,
  deliver: SmtpDeliver,
  options: { readonly clock?: Clock } = {},
): EmailTransport => {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    name: 'smtp',
    async dispatch(req: EmailWireRequest): Promise<EmailWireResult> {
      const built = smtpBuildMessage(config, req, clock);
      try {
        const reply = await deliver(built.envelope, built.data);
        return smtpParseResponse(reply, built.messageIdHeader);
      } catch (error: unknown) {
        return {
          ok: false,
          failureReason: `EMAIL_SMTP_NETWORK_ERROR: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        };
      }
    },
  };
};

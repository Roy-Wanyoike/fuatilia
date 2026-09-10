/**
 * Wire conformance for the SMTP transport (issue #127): request shape
 * (envelope, RFC 5322/MIME message), success mapping, and the full refusal
 * taxonomy — driven through a recorded fake `SmtpDeliver`. No network.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import type { Clock } from '../../domain/shared';
import {
  SMTP_DEFAULT_PORT,
  assertEmailAddress,
  assertHeaderSafe,
  buildRfc5322Date,
  maskEmail,
  smtpBuildMessage,
  smtpConfigFromEnv,
  smtpParseResponse,
  smtpTransport,
  type EmailWireRequest,
  type SmtpDeliver,
} from './transports';

const CONFIG = { host: 'relay.example', port: 2525, from: 'billing@fuatilia.co.ke', username: 'relay-user-1', password: 'sekrit-password-123' };
const ACCEPTED_AT = Date.UTC(2026, 8, 8, 9, 0, 0); // Tue, 08 Sep 2026 09:00:00 UTC
const FIXED_CLOCK: Clock = { now: () => new Date(ACCEPTED_AT) }; // Tue, 08 Sep 2026 09:00:00 UTC
const REQ: EmailWireRequest = {
  to: 'jane.doe@example.com',
  subject: 'Invoice INV-1042 is overdue',
  text: 'Invoice INV-1042 is due. Pay via the payment link.',
  clientRef: 'm-1#1',
};

const recorded = (code: number, message: string) => {
  const calls: { envelope: { from: string; to: string }; data: string }[] = [];
  const deliver: SmtpDeliver = async (envelope, data) => {
    calls.push({ envelope, data });
    return { code, message };
  };
  return { calls, deliver };
};

describe('maskEmail (redaction-safe metadata)', () => {
  it('masks the local part, keeps the routing domain', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('****@example.com');
    expect(maskEmail('a@b.co.ke')).toBe('****@b.co.ke');
    expect(maskEmail('no-at-sign')).toBe('****');
  });
});

describe('assertEmailAddress (malformed recipients are refusals, never normalizations)', () => {
  it.each([
    ['missing @', 'jane.doe.example.com'],
    ['double @', 'jane@@example.com'],
    ['empty local', '@example.com'],
    ['empty domain', 'jane@'],
    ['display-name form', 'Jane Doe <jane@example.com>'],
    ['space in local', 'jane doe@example.com'],
    ['single-label domain', 'jane@localhost'],
    ['label starting with hyphen', 'jane@-example.com'],
    ['label too long', 'jane@' + 'a'.repeat(64) + '.com'],
    ['address too long', `${'a'.repeat(250)}@example.com`],
    ['CR injection', 'jane@example.com\r\nBcc: victim@example.net'],
  ])('refuses %s', (_name, bad) => {
    expect(() => assertEmailAddress(bad, 'to')).toThrowError(DomainError);
  });

  it.each([
    ['plain', 'jane.doe@example.com'],
    ['plus-tagged', 'jane+inv-1042@example.co.ke'],
    ['atext specials', "j.o'e!#$%*-/=?^_`{|}~@example.com"],
    ['subdomain', 'jane@mail.a.example.com'],
  ])('accepts %s', (_name, good) => {
    expect(() => assertEmailAddress(good, 'to')).not.toThrow();
  });

  it('masks the address in refusal messages', () => {
    const bad = 'jane.doe@@example.com';
    try {
      assertEmailAddress(bad, 'to');
      expect.unreachable();
    } catch (error) {
      // the masked form (never the local part) is the only trace of the address
      expect((error as Error).message).toContain(maskEmail(bad));
      expect((error as Error).message).not.toContain('jane.doe');
    }
  });
});

describe('assertHeaderSafe', () => {
  it.each([
    ['bare LF', 'subject\nBcc: victim@example.net'],
    ['bare CR', 'subject\rbecause'],
    ['CRLF', 'subject\r\nBcc: victim@example.net'],
  ])('refuses %s without echoing the value', (_name, bad) => {
    expect(() => assertHeaderSafe(bad, 'subject')).toThrowError(/header injection refused/);
    expect(() => assertHeaderSafe(bad, 'subject')).not.toThrow(/victim/);
  });
  it('allows ordinary subjects', () => {
    expect(() => assertHeaderSafe('Invoice INV-1042 is overdue', 'subject')).not.toThrow();
  });
});

describe('smtpConfigFromEnv (credentials are env-only)', () => {
  const env = (values: Record<string, string>) => (key: string) => values[key] ?? '';

  it('refuses a missing host', () => {
    expect(() => smtpConfigFromEnv(env({ SMTP_FROM: 'b@fuatilia.co.ke' }))).toThrowError(/SMTP_HOST is required/);
  });
  it('refuses a missing sender', () => {
    expect(() => smtpConfigFromEnv(env({ SMTP_HOST: 'relay' }))).toThrowError(/SMTP_FROM is required/);
  });
  it('refuses a malformed sender', () => {
    expect(() => smtpConfigFromEnv(env({ SMTP_HOST: 'relay', SMTP_FROM: 'billing' }))).toThrowError(DomainError);
  });
  it('refuses a half-supplied credential pair', () => {
    expect(() => smtpConfigFromEnv(env({ SMTP_HOST: 'relay', SMTP_FROM: 'b@fuatilia.co.ke', SMTP_PASSWORD: 'p' }))).toThrowError(
      /must be set together/,
    );
  });
  it('refuses a non-numeric or out-of-range port', () => {
    expect(() => smtpConfigFromEnv(env({ SMTP_HOST: 'relay', SMTP_FROM: 'b@f.co.ke', SMTP_PORT: 'smtp' }))).toThrowError(/SMTP_PORT/);
    expect(() => smtpConfigFromEnv(env({ SMTP_HOST: 'relay', SMTP_FROM: 'b@f.co.ke', SMTP_PORT: '70000' }))).toThrowError(/SMTP_PORT/);
  });
  it('defaults the port to 587 and reads credentials + relay domain', () => {
    const config = smtpConfigFromEnv(
      env({ SMTP_HOST: 'relay.example', SMTP_FROM: 'billing@fuatilia.co.ke', SMTP_USERNAME: 'u', SMTP_PASSWORD: 'p', SMTP_RELAY_DOMAIN: 'mx.fuatilia.co.ke' }),
    );
    expect(config).toEqual({ host: 'relay.example', port: 587, from: 'billing@fuatilia.co.ke', relayDomain: 'mx.fuatilia.co.ke', username: 'u', password: 'p' });
    expect(SMTP_DEFAULT_PORT).toBe(587);
  });
});

describe('smtpBuildMessage (RFC 5322 / MIME conformance)', () => {
  it('builds the documented text/plain message (CRLF, base64, deterministic ids)', () => {
    const { envelope, data, messageIdHeader } = smtpBuildMessage(CONFIG, REQ, FIXED_CLOCK);
    expect(envelope).toEqual({ from: 'billing@fuatilia.co.ke', to: 'jane.doe@example.com' });
    expect(data).toContain('From: billing@fuatilia.co.ke\r\n');
    expect(data).toContain('To: jane.doe@example.com\r\n');
    expect(data).toContain(`Subject: Invoice INV-1042 is overdue\r\n`);
    expect(data).toContain('Date: Tue, 08 Sep 2026 09:00:00 +0000\r\n');
    expect(data).toContain(`Message-ID: <m-1.1.${ACCEPTED_AT}@fuatilia.co.ke>\r\n`);
    expect(data).toContain('MIME-Version: 1.0\r\n');
    expect(data).toContain('Content-Type: text/plain; charset=utf-8\r\n');
    expect(data).toContain('Content-Transfer-Encoding: base64\r\n');
    expect(data.endsWith('\r\n')).toBe(true);
    expect(messageIdHeader).toBe(`<m-1.1.${ACCEPTED_AT}@fuatilia.co.ke>`);
    // body round-trips: decode is possible through the same runtime Buffer
    const body = data.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(REQ.text);
  });

  it('builds a multipart/alternative message when html is present', () => {
    const { data } = smtpBuildMessage(CONFIG, { ...REQ, html: '<p>Invoice INV-1042 is due</p>' }, FIXED_CLOCK);
    expect(data).toContain('Content-Type: multipart/alternative; boundary="=_fuatilia_m-1.1"\r\n');
    expect(data).toContain('--=_fuatilia_m-1.1\r\nContent-Type: text/plain; charset=utf-8');
    expect(data).toContain('--=_fuatilia_m-1.1\r\nContent-Type: text/html; charset=utf-8');
    expect(data).toContain('--=_fuatilia_m-1.1--\r\n');
  });

  it('honors the per-message sender override and the relay-domain override', () => {
    const built = smtpBuildMessage({ ...CONFIG, relayDomain: 'mx.fuatilia.co.ke' }, { ...REQ, from: 'dunning@fuatilia.co.ke' }, FIXED_CLOCK);
    expect(built.data).toContain('From: dunning@fuatilia.co.ke');
    expect(built.envelope.from).toBe('dunning@fuatilia.co.ke');
    expect(built.messageIdHeader).toBe(`<m-1.1.${ACCEPTED_AT}@mx.fuatilia.co.ke>`);
  });

  it('every message line stays within the 76-char wire budget (RFC 2045 base64 wrapping)', () => {
    const long = 'x'.repeat(500);
    const { data } = smtpBuildMessage(CONFIG, { ...REQ, text: long }, FIXED_CLOCK);
    for (const line of data.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('encodes non-ASCII subjects as RFC 2047 encoded-words', () => {
    const { data } = smtpBuildMessage(CONFIG, { ...REQ, subject: 'Malipo ya INV-1042 — kumbuka' }, FIXED_CLOCK);
    const encoded = data.split('\r\n').find((l) => l.startsWith('Subject: =?UTF-8?B?'));
    expect(encoded).toBeDefined();
  });

  it('refuses malformed recipients before any I/O', () => {
    expect(() => smtpBuildMessage(CONFIG, { ...REQ, to: 'not-an-address' }, FIXED_CLOCK)).toThrowError(/must be a bare address/);
  });

  it('refuses an empty subject and an empty clientRef', () => {
    expect(() => smtpBuildMessage(CONFIG, { ...REQ, subject: '   ' }, FIXED_CLOCK)).toThrowError(/EMAIL_SUBJECT_REQUIRED|requires a subject/);
    expect(() => smtpBuildMessage(CONFIG, { ...REQ, clientRef: '' }, FIXED_CLOCK)).toThrowError(/cannot carry a Message-ID/);
  });

  it('credentials never reach the wire', () => {
    const { data, envelope } = smtpBuildMessage(CONFIG, REQ, FIXED_CLOCK);
    expect(data).not.toContain('sekrit-password-123');
    expect(data).not.toContain('relay-user-1');
    expect(JSON.stringify(envelope)).not.toContain('sekrit-password-123');
  });

  it('different attempts of the same message get different Message-IDs', () => {
    const a = smtpBuildMessage(CONFIG, { ...REQ, clientRef: 'm-1#1' }, FIXED_CLOCK).messageIdHeader;
    const b = smtpBuildMessage(CONFIG, { ...REQ, clientRef: 'm-1#2' }, FIXED_CLOCK).messageIdHeader;
    expect(a).not.toBe(b);
  });

  it('an invalid clock is refused, never defaulted', () => {
    const broken: Clock = { now: () => new Date('not-a-date') };
    expect(() => smtpBuildMessage(CONFIG, REQ, broken)).toThrowError(/invalid Date/);
  });
});

describe('buildRfc5322Date', () => {
  it.each([
    ['Tue, 08 Sep 2026 09:00:00 +0000', Date.UTC(2026, 8, 8, 9, 0, 0)],
    ['Wed, 01 Jan 2025 00:00:00 +0000', Date.UTC(2025, 0, 1, 0, 0, 0)],
    ['Sun, 31 Dec 2023 23:59:59 +0000', Date.UTC(2023, 11, 31, 23, 59, 59)],
  ])('%s', (expected, ms) => {
    expect(buildRfc5322Date(new Date(ms))).toBe(expected);
  });
});

describe('smtpParseResponse (refusal taxonomy)', () => {
  const MID = '<m-1.1.1@relay.example>';
  it.each([
    ['250 acceptance', 250, 'OK', { ok: true, providerRef: MID }],
    ['251 forwarded is acceptance', 251, 'User not local; will forward', { ok: true, providerRef: MID }],
    ['421 relay outage is retryable', 421, 'Service not available', { ok: false, failureReason: 'EMAIL_SMTP_421: Service not available', retryable: true }],
    ['450 greylisting is retryable', 450, 'mailbox temporarily unavailable', { ok: false, failureReason: 'EMAIL_SMTP_450: mailbox temporarily unavailable', retryable: true }],
    ['451 transient is retryable', 451, 'try again later', { ok: false, failureReason: 'EMAIL_SMTP_451: try again later', retryable: true }],
    ['550 unknown mailbox is permanent', 550, 'User unknown', { ok: false, failureReason: 'EMAIL_SMTP_550: User unknown', retryable: false }],
    ['554 policy rejection is permanent', 554, 'spam detected', { ok: false, failureReason: 'EMAIL_SMTP_554: spam detected', retryable: false }],
    ['empty relay banner still refuses with a code', 552, '   ', { ok: false, failureReason: 'EMAIL_SMTP_552: no detail from relay', retryable: false }],
    ['relay banner is truncated to 200 chars', 553, 'x'.repeat(400), { ok: false, failureReason: `EMAIL_SMTP_553: ${'x'.repeat(200)}`, retryable: false }],
    ['out-of-space code is malformed-transient', 999, 'wat', { ok: false, failureReason: 'EMAIL_SMTP_REPLY_MALFORMED', retryable: true }],
    ['non-numeric code is malformed-transient', NaN, 'wat', { ok: false, failureReason: 'EMAIL_SMTP_REPLY_MALFORMED', retryable: true }],
  ])('%s', (_name, code, message, expected) => {
    expect(smtpParseResponse({ code, message }, MID)).toEqual(expected);
  });
});

describe('smtpTransport through the injected port', () => {
  it('dispatch returns the classified outcome and records exactly one call', async () => {
    const { deliver, calls } = recorded(250, 'OK');
    const result = await smtpTransport(CONFIG, deliver, { clock: FIXED_CLOCK }).dispatch(REQ);
    expect(result).toEqual({ ok: true, providerRef: `<m-1.1.${ACCEPTED_AT}@fuatilia.co.ke>` });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.envelope).toEqual({ from: 'billing@fuatilia.co.ke', to: 'jane.doe@example.com' });
  });

  it('transient relay reply is a retryable refusal, never a throw', async () => {
    const { deliver } = recorded(451, 'temporary local problem');
    const result = await smtpTransport(CONFIG, deliver).dispatch(REQ);
    expect(result).toEqual({ ok: false, failureReason: 'EMAIL_SMTP_451: temporary local problem', retryable: true });
  });

  it('network failures are retryable refusals, never throws', async () => {
    const deliver: SmtpDeliver = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await smtpTransport(CONFIG, deliver).dispatch(REQ);
    expect(result).toEqual({ ok: false, failureReason: 'EMAIL_SMTP_NETWORK_ERROR: ECONNRESET', retryable: true });
  });

  it('malformed recipients are refused BEFORE the port is touched', async () => {
    let touched = false;
    const deliver: SmtpDeliver = async () => {
      touched = true;
      return { code: 250, message: 'OK' };
    };
    await expect(smtpTransport(CONFIG, deliver).dispatch({ ...REQ, to: 'jane@@example.com' })).rejects.toThrowError(/malformed local part/);
    expect(touched).toBe(false);
  });
});

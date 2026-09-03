import { describe, expect, it } from 'vitest';
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import { cancelLink, createLink, disableLink, effectiveStatus, expireIfDue, uuidFromSeed } from './link';
import type { CreateLinkCommand, LinkCreationDeps, LinkStatus, PaymentLink } from './link';
import { redeem } from './redeem';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const R1 = uid(911);
const R2 = uid(912);

const T0 = '2026-06-01T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (act: () => unknown, code: string): void => {
  try {
    act();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const DEFAULT_TOKEN = 'AbCdEfGhIjKlMnOpQrSt'; // 19 chars, URL-safe alphabet
const deps = (token: string = DEFAULT_TOKEN, iso: string = T0): LinkCreationDeps => ({
  clock: at(iso),
  generateToken: () => token,
});

const cmd = (over: Partial<CreateLinkCommand> = {}): CreateLinkCommand => ({
  orgId: ORG,
  receivableIds: [R1],
  currency: 'KES',
  targetAmountMinor: Money.ofMinor(85_000, 'KES'),
  config: { singleUse: false, allowPartial: false },
  ...over,
});

/** Drive a link to any non-active status using legal paths only. */
const linkAt = (status: LinkStatus, over: Partial<CreateLinkCommand> = {}): PaymentLink => {
  const created = createLink(cmd(over), deps()).link;
  if (status === 'active') return created;
  if (status === 'expired') {
    const expiring = createLink(
      cmd({ config: { singleUse: false, allowPartial: false, expiresAt: new Date('2026-06-30T08:00:00.000Z') } }),
      deps(),
    ).link;
    return expireIfDue(expiring, at('2026-07-01T00:00:00.000Z')).link;
  }
  if (status === 'disabled') return disableLink(created, 'ops rotate', at('2026-06-02T00:00:00.000Z')).link;
  if (status === 'cancelled') return cancelLink(created, 'customer paid offline', at('2026-06-02T00:00:00.000Z')).link;
  // completed: a full redemption on the exact-target link
  const { link } = redeem(
    { token: created.token, idempotencyKey: 'full-1', amount: created.targetAmountMinor! },
    { clock: at('2026-06-02T00:00:00.000Z'), links: [created] },
  );
  return link;
};

// --- creation ---------------------------------------------------------------

describe('createLink — fixed and open modes (SPEC §28)', () => {
  it('creates an active fixed single-use link with the generated token and a created event', () => {
    const { link, events } = createLink(
      cmd({ targetAmountMinor: Money.ofMinor(85_000, 'KES'), config: { singleUse: true, allowPartial: false } }),
      deps(),
    );
    expect(link.status).toBe('active');
    expect(link.token).toBe(DEFAULT_TOKEN);
    expect(link.orgId).toBe(ORG);
    expect(link.receivableIds).toEqual([R1]);
    expect(link.currency).toBe('KES');
    expect(link.targetAmountMinor?.amount).toBe(85_000n);
    expect(link.config).toEqual({ singleUse: true, allowPartial: false });
    expect(link.redeemedTotalMinor.isZero()).toBe(true);
    expect(link.redemptionCount).toBe(0);
    expect(link.createdAt).toEqual(new Date(T0));
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.name).toBe('paymentlink.created');
    expect(evt.version).toBe(1);
    expect(evt.aggregateId).toBe(link.linkId);
    expect(evt.occurredAt).toEqual(new Date(T0));
    expect(evt.payload).toMatchObject({
      linkId: link.linkId,
      orgId: ORG,
      receivableIds: [R1],
      mode: 'fixed',
      targetAmountMinor: 85_000n,
      currency: 'KES',
      singleUse: true,
      allowPartial: false,
    });
  });

  it('creates an open-amount link bounded by min/max (mode: open, no target)', () => {
    const { link, events } = createLink(
      cmd({
        targetAmountMinor: undefined,
        minAmountMinor: Money.ofMinor(500, 'KES'),
        maxAmountMinor: Money.ofMinor(10_000, 'KES'),
      }),
      deps(),
    );
    expect(link.targetAmountMinor).toBeUndefined();
    expect(link.minAmountMinor?.amount).toBe(500n);
    expect(link.maxAmountMinor?.amount).toBe(10_000n);
    const evt = events[0]!;
    expect(evt.name).toBe('paymentlink.created');
    if (evt.name !== 'paymentlink.created') throw new Error('unexpected event');
    expect(evt.payload.mode).toBe('open');
    expect(evt.payload.minAmountMinor).toBe(500n);
    expect(evt.payload.maxAmountMinor).toBe(10000n);
    expect('targetAmountMinor' in evt.payload).toBe(false);
  });

  it('supports a fully open link (no bounds) and multi-receivable links (deduped)', () => {
    const { link } = createLink(
      cmd({ targetAmountMinor: undefined, receivableIds: [R1, R2, R1] }),
      deps(),
    );
    expect(link.minAmountMinor).toBeUndefined();
    expect(link.maxAmountMinor).toBeUndefined();
    expect(link.receivableIds).toEqual([R1, R2]);
  });

  it.each([
    { name: 'no receivables', over: { receivableIds: [] }, code: 'LINK_RECEIVABLE_REQUIRED' },
    {
      name: 'target AND bounds (mode conflict)',
      over: { targetAmountMinor: Money.ofMinor(100, 'KES'), minAmountMinor: Money.ofMinor(50, 'KES') },
      code: 'LINK_AMOUNT_MODE_CONFLICT',
    },
    {
      name: 'target zero',
      over: { targetAmountMinor: Money.ofMinor(0, 'KES') },
      code: 'LINK_TARGET_INVALID',
    },
    {
      name: 'min bound zero',
      over: { targetAmountMinor: undefined, minAmountMinor: Money.ofMinor(0, 'KES') },
      code: 'LINK_BOUNDS_INVALID',
    },
    {
      name: 'min exceeds max',
      over: {
        targetAmountMinor: undefined,
        minAmountMinor: Money.ofMinor(10_000, 'KES'),
        maxAmountMinor: Money.ofMinor(500, 'KES'),
      },
      code: 'LINK_BOUNDS_INVALID',
    },
    {
      name: 'expiresAt in the past',
      over: { config: { singleUse: false, allowPartial: false, expiresAt: new Date('2026-05-01T00:00:00.000Z') } },
      code: 'LINK_EXPIRY_INVALID',
    },
    {
      name: 'expiresAt exactly at creation instant',
      over: { config: { singleUse: false, allowPartial: false, expiresAt: new Date(T0) } },
      code: 'LINK_EXPIRY_INVALID',
    },
  ])('refuses creation: $name ($code)', ({ over, code }) => {
    expectCode(() => createLink(cmd(over), deps()), code);
  });

  it.each([
    { token: '', why: 'blank' },
    { token: 'short', why: 'too short' },
    { token: 'a'.repeat(129), why: 'too long' },
    { token: 'pay+alice@example.com', why: 'email-shaped' },
    { token: '+254722000000', why: 'phone-shaped' },
    { token: '{"customer":"Alice"}', why: 'JSON-shaped' },
    { token: 'tok=AbCdEfGh12', why: 'base64 padding/separator' },
    { token: 'has space inside 1234', why: 'whitespace' },
    { token: 'tok:AbCdEfGh123456', why: 'colon separator' },
  ])('rejects PII/structured token shapes: $why (LINK_TOKEN_MALFORMED)', ({ token }) => {
    expectCode(() => createLink(cmd(), deps(token)), 'LINK_TOKEN_MALFORMED');
  });
});

// --- token privacy (secure tokenization core) --------------------------------

describe('token privacy — opaque, injected, never derived or leaked', () => {
  it('uses the injected generator output verbatim (no derivation, no encoding)', () => {
    const token = 'Zx9Q_wR7sT-uV2wX4y';
    const { link } = createLink(cmd(), deps(token));
    expect(link.token).toBe(token); // byte-for-byte
  });

  it('two links with IDENTICAL command data get different tokens (generator owns entropy)', () => {
    let n = 0;
    const gen = (): string => `link-token-${String(++n).padStart(2, '0')}-aaaa`;
    const a = createLink(cmd(), { clock: at(T0), generateToken: gen }).link;
    const b = createLink(cmd(), { clock: at(T0), generateToken: gen }).link;
    expect(a.token).not.toBe(b.token);
    expect(a.token).toBe('link-token-01-aaaa');
    expect(b.token).toBe('link-token-02-aaaa');
  });

  it('the domain never mixes command data into the token (fixed token over varied commands)', () => {
    const fixed = 'SameTokenValue-123';
    const a = createLink(cmd({ targetAmountMinor: Money.ofMinor(1, 'KES') }), deps(fixed)).link;
    const b = createLink(
      cmd({ orgId: uid(999), receivableIds: [R2], currency: 'USD', targetAmountMinor: undefined }),
      deps(fixed),
    ).link;
    expect(a.token).toBe(fixed);
    expect(b.token).toBe(fixed);
  });

  it('the token is a secret: never mirrored into event payloads', () => {
    const { link, events } = createLink(cmd(), deps());
    const evt = events[0]!;
    if (evt.name !== 'paymentlink.created') throw new Error('unexpected event');
    const wire = JSON.stringify(evt, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(wire).not.toContain(link.token);
    expect(Object.keys(evt.payload)).not.toContain('token');
  });

  it('linkId: caller-supplied preferred; deterministic fallback derived from (org, token)', () => {
    const supplied = uid(555);
    const a = createLink(cmd({ linkId: supplied }), deps()).link;
    expect(a.linkId).toBe(supplied);
    const b = createLink(cmd(), deps()).link;
    expect(b.linkId).toBe(uuidFromSeed(`paymentlink:${ORG}:${DEFAULT_TOKEN}`));
    expect(b.linkId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// --- lifecycle: expiry --------------------------------------------------------

describe('lifecycle — expiry is time-driven with an inclusive boundary', () => {
  const EXP = '2026-06-30T08:00:00.000Z';
  const expiring = (): PaymentLink =>
    createLink(cmd({ config: { singleUse: false, allowPartial: true, expiresAt: new Date(EXP) } }), deps()).link;

  it.each([
    { name: 'no expiry stays active far in the future', hasExpiry: false, now: '2027-01-01T00:00:00.000Z', want: 'active' },
    { name: 'before the boundary is active', hasExpiry: true, now: '2026-06-29T23:59:59.999Z', want: 'active' },
    { name: 'exactly AT the boundary is expired (inclusive)', hasExpiry: true, now: EXP, want: 'expired' },
    { name: 'after the boundary is expired', hasExpiry: true, now: '2026-06-30T08:00:00.001Z', want: 'expired' },
  ])('effectiveStatus: $name', ({ hasExpiry, now, want }) => {
    const link = hasExpiry
      ? expiring()
      : createLink(cmd({ targetAmountMinor: undefined, minAmountMinor: Money.ofMinor(500, 'KES') }), deps()).link;
    expect(effectiveStatus(link, at(now).now())).toBe(want);
  });

  it.each([
    { name: 'not due → unchanged, no events', now: '2026-06-29T23:59:59.999Z', wantStatus: 'active', wantEvents: 0 },
    { name: 'at the boundary → expired + paymentlink.expired', now: EXP, wantStatus: 'expired', wantEvents: 1 },
    { name: 'after the boundary → expired + paymentlink.expired', now: '2026-07-01T00:00:00.000Z', wantStatus: 'expired', wantEvents: 1 },
  ])('expireIfDue: $name', ({ now, wantStatus, wantEvents }) => {
    const link = expiring();
    const { link: next, events } = expireIfDue(link, at(now));
    expect(next.status).toBe(wantStatus);
    expect(events).toHaveLength(wantEvents);
    if (wantEvents === 1) {
      const evt = events[0]!;
      expect(evt.name).toBe('paymentlink.expired');
      if (evt.name !== 'paymentlink.expired') throw new Error('unexpected event');
      expect(evt.payload).toMatchObject({ linkId: link.linkId, expiredAt: new Date(now) });
      expect(next.expiredAt).toEqual(new Date(now));
    }
  });

  it('expireIfDue is idempotent once flipped, and never touches terminal non-expired links', () => {
    const link = expiring();
    const first = expireIfDue(link, at('2026-07-01T00:00:00.000Z'));
    expect(first.events).toHaveLength(1);
    const second = expireIfDue(first.link, at('2026-07-02T00:00:00.000Z'));
    expect(second.link).toBe(first.link);
    expect(second.events).toHaveLength(0);
    const disabled = disableLink(expiring(), 'ops', at(T0)).link;
    const untouched = expireIfDue(disabled, at('2026-07-01T00:00:00.000Z'));
    expect(untouched.link.status).toBe('disabled');
    expect(untouched.events).toHaveLength(0);
  });

  it('original aggregate is untouched by transitions (immutability)', () => {
    const link = expiring();
    expireIfDue(link, at('2026-07-01T00:00:00.000Z'));
    expect(link.status).toBe('active');
    expect(link.expiredAt).toBeUndefined();
  });
});

// --- lifecycle: admin disable / cancel ----------------------------------------

describe('lifecycle — admin disable/cancel from active only', () => {
  it('disableLink: active → disabled with reason + paymentlink.disabled', () => {
    const link = createLink(cmd(), deps()).link;
    const at2 = '2026-06-05T10:00:00.000Z';
    const { link: next, events } = disableLink(link, 'staff fraud watch', at(at2));
    expect(next.status).toBe('disabled');
    expect(next.disabledAt).toEqual(new Date(at2));
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.name).toBe('paymentlink.disabled');
    if (evt.name !== 'paymentlink.disabled') throw new Error('unexpected event');
    expect(evt.payload).toMatchObject({ linkId: link.linkId, reason: 'staff fraud watch', disabledAt: new Date(at2) });
  });

  it('cancelLink: active → cancelled with reason + paymentlink.cancelled', () => {
    const link = createLink(cmd(), deps()).link;
    const at2 = '2026-06-06T10:00:00.000Z';
    const { link: next, events } = cancelLink(link, 'superseded by new link', at(at2));
    expect(next.status).toBe('cancelled');
    expect(next.cancelledAt).toEqual(new Date(at2));
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.name).toBe('paymentlink.cancelled');
    if (evt.name !== 'paymentlink.cancelled') throw new Error('unexpected event');
    expect(evt.payload).toMatchObject({ linkId: link.linkId, reason: 'superseded by new link' });
  });

  it.each([['', ' ']])('blank reasons are rejected for %s (LINK_REASON_REQUIRED)', (blank) => {
    const link = createLink(cmd(), deps()).link;
    expectCode(() => disableLink(link, blank, at(T0)), 'LINK_REASON_REQUIRED');
    expectCode(() => cancelLink(link, blank, at(T0)), 'LINK_REASON_REQUIRED');
  });

  it.each([
    { status: 'expired' as LinkStatus },
    { status: 'completed' as LinkStatus },
    { status: 'disabled' as LinkStatus },
    { status: 'cancelled' as LinkStatus },
  ])('cannot disable or cancel a $status link (LINK_TRANSITION_INVALID)', ({ status }) => {
    const link = linkAt(status);
    expectCode(() => disableLink(link, 'late ops', at(T0)), 'LINK_TRANSITION_INVALID');
    expectCode(() => cancelLink(link, 'late ops', at(T0)), 'LINK_TRANSITION_INVALID');
  });
});

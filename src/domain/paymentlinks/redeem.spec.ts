import { describe, expect, it } from 'vitest';
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import { cancelLink, createLink, disableLink, expireIfDue } from './link';
import type { CreateLinkCommand, LinkCreationDeps, PaymentLink } from './link';
import { redeem } from './redeem';
import type { RedeemCommand, RedemptionRecord } from './redeem';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const R1 = uid(911);

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

const DEFAULT_TOKEN = 'AbCdEfGhIjKlMnOpQrSt';
const deps = (token: string = DEFAULT_TOKEN): LinkCreationDeps => ({
  clock: at(T0),
  generateToken: () => token,
});

const cmd = (over: Partial<CreateLinkCommand> = {}): CreateLinkCommand => ({
  orgId: ORG,
  receivableIds: [R1],
  currency: 'KES',
  targetAmountMinor: Money.ofMinor(85_000, 'KES'), // fixed, exact-only by default
  config: { singleUse: false, allowPartial: false },
  ...over,
});

const fixedExact = (): PaymentLink => createLink(cmd(), deps()).link;
const fixedPartial = (): PaymentLink =>
  createLink(cmd({ config: { singleUse: false, allowPartial: true } }), deps()).link;
const openBounded = (): PaymentLink =>
  createLink(
    cmd({
      targetAmountMinor: undefined,
      minAmountMinor: Money.ofMinor(500, 'KES'),
      maxAmountMinor: Money.ofMinor(10_000, 'KES'),
    }),
    deps(),
  ).link;

const rc = (over: Partial<RedeemCommand>): RedeemCommand => ({
  token: DEFAULT_TOKEN,
  idempotencyKey: 'redeem-1',
  amount: Money.ofMinor(85_000, 'KES'),
  ...over,
});

// --- full / exact redemption ---------------------------------------------------

describe('redeem — exact target on a fixed link (full payment → completed)', () => {
  it('a full redemption completes the link and emits redeemed → completed with an opaque intent', () => {
    const link = fixedExact();
    const when = '2026-06-03T09:30:00.000Z';
    const { link: next, redemption, duplicate, events } = redeem(
      rc({ amount: Money.ofMinor(85_000, 'KES'), idempotencyKey: 'cust-abc-1' }),
      { clock: at(when), links: [link] },
    );
    expect(duplicate).toBe(false);
    expect(next.status).toBe('completed');
    expect(next.completedAt).toEqual(new Date(when));
    expect(next.redeemedTotalMinor.amount).toBe(85_000n);
    expect(next.redemptionCount).toBe(1);
    expect(redemption.linkId).toBe(link.linkId);
    expect(redemption.intentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redemption.redeemedAt).toEqual(new Date(when));
    expect(events.map((e) => e.name)).toEqual(['paymentlink.redeemed', 'paymentlink.completed']);
    const redeemed = events[0]!;
    if (redeemed.name !== 'paymentlink.redeemed') throw new Error('unexpected event');
    expect(redeemed.aggregateId).toBe(link.linkId);
    expect(redeemed.payload).toEqual({
      linkId: link.linkId,
      intentId: redemption.intentId,
      amountMinor: 85_000n,
      currency: 'KES',
      redeemedAt: new Date(when),
    });
    const completed = events[1]!;
    if (completed.name !== 'paymentlink.completed') throw new Error('unexpected event');
    expect(completed.payload).toEqual({
      linkId: link.linkId,
      collectedMinor: 85_000n,
      completedAt: new Date(when),
    });
  });

  it('a caller-supplied intentId is honored verbatim (opaque hand-off to payments)', () => {
    const intent = uid(777);
    const { redemption } = redeem(rc({ intentId: intent }), { clock: at(T0), links: [fixedExact()] });
    expect(redemption.intentId).toBe(intent);
  });

  it.each([
    { name: 'under the target', amount: 84_999 },
    { name: 'over the target', amount: 85_001 },
  ])('!allowPartial rejects a $name amount (LINK_AMOUNT_EXACT_REQUIRED)', ({ amount }) => {
    expectCode(
      () => redeem(rc({ amount: Money.ofMinor(amount, 'KES') }), { clock: at(T0), links: [fixedExact()] }),
      'LINK_AMOUNT_EXACT_REQUIRED',
    );
  });
});

// --- partial redemptions --------------------------------------------------------

describe('redeem — partial payments on an allowPartial fixed link', () => {
  it('partials accumulate: active after each until the target is met, then completed', () => {
    let link = fixedPartial();
    const step1 = redeem(rc({ idempotencyKey: 'p1', amount: Money.ofMinor(35_000, 'KES') }), {
      clock: at('2026-06-02T00:00:00.000Z'),
      links: [link],
    });
    expect(step1.link.status).toBe('active');
    expect(step1.link.redeemedTotalMinor.amount).toBe(35_000n);
    expect(step1.events.map((e) => e.name)).toEqual(['paymentlink.redeemed']);
    link = step1.link;
    const step2 = redeem(rc({ idempotencyKey: 'p2', amount: Money.ofMinor(50_000, 'KES') }), {
      clock: at('2026-06-03T00:00:00.000Z'),
      links: [link],
    });
    expect(step2.link.status).toBe('completed');
    expect(step2.link.redeemedTotalMinor.amount).toBe(85_000n);
    expect(step2.events.map((e) => e.name)).toEqual(['paymentlink.redeemed', 'paymentlink.completed']);
  });

  it('a partial that would overshoot the remaining target is rejected (LINK_AMOUNT_EXCEEDS_TARGET)', () => {
    const link = fixedPartial();
    expectCode(
      () => redeem(rc({ amount: Money.ofMinor(85_001, 'KES') }), { clock: at(T0), links: [link] }),
      'LINK_AMOUNT_EXCEEDS_TARGET',
    );
    const half = redeem(rc({ idempotencyKey: 'h1', amount: Money.ofMinor(50_000, 'KES') }), {
      clock: at(T0),
      links: [link],
    });
    expectCode(
      () => redeem(rc({ idempotencyKey: 'h2', amount: Money.ofMinor(35_001, 'KES') }), { clock: at(T0), links: [half.link] }),
      'LINK_AMOUNT_EXCEEDS_TARGET',
    );
  });
});

// --- open-amount bounds -----------------------------------------------------------

describe('redeem — open-amount bounds', () => {
  it.each([
    { name: 'just below min', amount: 499, code: 'LINK_AMOUNT_BELOW_MIN' },
    { name: 'just above max', amount: 10_001, code: 'LINK_AMOUNT_ABOVE_MAX' },
  ])('$name is rejected ($code)', ({ amount, code }) => {
    expectCode(
      () => redeem(rc({ amount: Money.ofMinor(amount, 'KES') }), { clock: at(T0), links: [openBounded()] }),
      code,
    );
  });

  it.each([500, 5_000, 10_000])('amount %s within/at bounds is accepted and stays active', (amount) => {
    const { link, events } = redeem(
      rc({ idempotencyKey: `open-${amount}`, amount: Money.ofMinor(amount, 'KES') }),
      { clock: at(T0), links: [openBounded()] },
    );
    expect(link.status).toBe('active'); // open links never complete on amount
    expect(link.redeemedTotalMinor.amount).toBe(BigInt(amount));
    expect(events.map((e) => e.name)).toEqual(['paymentlink.redeemed']);
  });

  it('an unbounded open link accepts any positive amount', () => {
    const unbounded = createLink(cmd({ targetAmountMinor: undefined }), deps()).link;
    for (const amount of [1, 100_000_000]) {
      const { link } = redeem(
        rc({ idempotencyKey: `u-${amount}`, amount: Money.ofMinor(amount, 'KES') }),
        { clock: at(T0), links: [unbounded] },
      );
      expect(link.status).toBe('active');
    }
  });
});

// --- status gating ---------------------------------------------------------------

describe('redeem — lifecycle gating (each terminal state has its own stable code)', () => {
  it.each([
    { status: 'expired' as const, code: 'LINK_EXPIRED' },
    { status: 'disabled' as const, code: 'LINK_DISABLED' },
    { status: 'cancelled' as const, code: 'LINK_CANCELLED' },
    { status: 'completed' as const, code: 'LINK_COMPLETED' },
  ])('a $status link rejects redemption ($code)', ({ status, code }) => {
    let link: PaymentLink;
    if (status === 'expired') {
      const withExpiry = createLink(
        cmd({ config: { singleUse: false, allowPartial: false, expiresAt: new Date('2026-06-30T08:00:00.000Z') } }),
        deps(),
      ).link;
      link = expireIfDue(withExpiry, at('2026-07-01T00:00:00.000Z')).link;
    } else if (status === 'disabled') {
      link = disableLink(createLink(cmd(), deps()).link, 'ops', at(T0)).link;
    } else if (status === 'cancelled') {
      link = cancelLink(createLink(cmd(), deps()).link, 'ops', at(T0)).link;
    } else {
      // completed multi-use: reach the fixed target via partial redemptions
      const partial = createLink(cmd({ config: { singleUse: false, allowPartial: true } }), deps()).link;
      const half = redeem(rc({ idempotencyKey: 'c1', amount: Money.ofMinor(35_000, 'KES') }), {
        clock: at(T0),
        links: [partial],
      }).link;
      link = redeem(rc({ idempotencyKey: 'c2', amount: Money.ofMinor(50_000, 'KES') }), {
        clock: at(T0),
        links: [half],
      }).link;
    }
    expect(link.status).toBe(status);
    expectCode(() => redeem(rc({ amount: Money.ofMinor(1_000, 'KES') }), { clock: at(T0), links: [link] }), code);
  });

  it('a consumed single-use link answers LINK_ALREADY_REDEEMED on a second token presentation', () => {
    const link = createLink(cmd({ config: { singleUse: true, allowPartial: false } }), deps()).link;
    const first = redeem(rc({ idempotencyKey: 'one' }), { clock: at(T0), links: [link] });
    expect(first.link.status).toBe('completed');
    expectCode(
      () => redeem(rc({ idempotencyKey: 'two' }), { clock: at(T0), links: [first.link] }),
      'LINK_ALREADY_REDEEMED',
    );
  });

  it('an unknown or blank token never resolves a link (token is the ONLY path)', () => {
    expectCode(() => redeem(rc({ token: 'NoSuchTokenAnywhere-1' }), { clock: at(T0), links: [fixedExact()] }), 'LINK_NOT_FOUND');
    expectCode(() => redeem(rc({ token: '   ' }), { clock: at(T0), links: [fixedExact()] }), 'LINK_TOKEN_REQUIRED');
    expectCode(() => redeem(rc({ token: 'NoSuchTokenAnywhere-1' }), { clock: at(T0) }), 'LINK_NOT_FOUND');
  });
});

// --- input validation ---------------------------------------------------------------

describe('redeem — input validation (money + keys)', () => {
  it.each([
    { name: 'zero amount', amount: Money.ofMinor(0, 'KES'), code: 'AMOUNT_MUST_BE_POSITIVE' },
    { name: 'currency mismatch (R10)', amount: Money.ofMinor(85_000, 'USD'), code: 'CURRENCY_MISMATCH' },
  ])('$name is rejected ($code)', ({ amount, code }) => {
    expectCode(() => redeem(rc({ amount }), { clock: at(T0), links: [fixedExact()] }), code);
  });

  it('a blank idempotency key is rejected (R9)', () => {
    expectCode(
      () => redeem(rc({ idempotencyKey: '   ' }), { clock: at(T0), links: [fixedExact()] }),
      'LINK_IDEMPOTENCY_KEY_REQUIRED',
    );
  });
});

// --- idempotent redemption (R9 style) ---------------------------------------------

describe('redeem — idempotency: unique(linkId, idempotencyKey)', () => {
  const first = (): { link: PaymentLink; redemption: RedemptionRecord } => {
    const link = fixedPartial();
    const { redemption, link: updated } = redeem(
      rc({ idempotencyKey: 'retry-me', amount: Money.ofMinor(35_000, 'KES') }),
      { clock: at('2026-06-02T00:00:00.000Z'), links: [link] },
    );
    return { link: updated, redemption };
  };

  it('a retry with the same key returns the ORIGINAL redemption/intent unchanged and only observes', () => {
    const { link, redemption } = first();
    const result = redeem(rc({ idempotencyKey: 'retry-me', amount: Money.ofMinor(35_000, 'KES') }), {
      clock: at('2026-06-09T00:00:00.000Z'),
      links: [link],
      redemptions: [redemption],
    });
    expect(result.duplicate).toBe(true);
    expect(result.redemption).toBe(redemption); // the original — never re-processed
    expect(result.link).toBe(link); // link state untouched by the duplicate
    expect(result.link.redemptionCount).toBe(1);
    expect(result.link.redeemedTotalMinor.amount).toBe(35_000n);
    expect(result.events.map((e) => e.name)).toEqual(['paymentlink.duplicateRedemptionObserved']);
    const evt = result.events[0]!;
    if (evt.name !== 'paymentlink.duplicateRedemptionObserved') throw new Error('unexpected event');
    expect(evt.payload).toMatchObject({
      linkId: link.linkId,
      idempotencyKey: 'retry-me',
      intentId: redemption.intentId,
      seenAt: new Date('2026-06-09T00:00:00.000Z'),
    });
  });

  it('a replay with no prior state derives the SAME intent id (deterministic fallback)', () => {
    const { redemption } = first();
    const replay = redeem(rc({ idempotencyKey: 'retry-me', amount: Money.ofMinor(35_000, 'KES') }), {
      clock: at('2026-06-10T00:00:00.000Z'),
      links: [fixedPartial()],
    });
    expect(replay.redemption.intentId).toBe(redemption.intentId);
    expect(replay.redemption.redemptionId).toBe(redemption.redemptionId);
  });

  it('the same key with a different amount is tampering, not a retry (LINK_REDEMPTION_AMOUNT_MISMATCH)', () => {
    const { link, redemption } = first();
    expectCode(
      () =>
        redeem(rc({ idempotencyKey: 'retry-me', amount: Money.ofMinor(36_000, 'KES') }), {
          clock: at(T0),
          links: [link],
          redemptions: [redemption],
        }),
      'LINK_REDEMPTION_AMOUNT_MISMATCH',
    );
  });

  it('the same key on a DIFFERENT link is an independent journey (not a duplicate)', () => {
    const { redemption } = first();
    const other = createLink(cmd({ config: { singleUse: false, allowPartial: true } }), deps('OtherLinkToken-0001')).link;
    const result = redeem(
      rc({ token: 'OtherLinkToken-0001', idempotencyKey: 'retry-me', amount: Money.ofMinor(35_000, 'KES') }),
      { clock: at(T0), links: [other], redemptions: [redemption] },
    );
    expect(result.duplicate).toBe(false);
    expect(result.redemption.linkId).toBe(other.linkId);
  });
});

// --- expiry boundary via injected clock ------------------------------------------

describe('redeem — expiry boundary is exact (inclusive)', () => {
  const EXP = '2026-06-30T08:00:00.000Z';
  const expiring = (): PaymentLink =>
    createLink(
      cmd({ config: { singleUse: false, allowPartial: false, expiresAt: new Date(EXP) } }),
      deps(),
    ).link;

  it('one millisecond before the boundary redemption succeeds', () => {
    const link = expiring();
    const { link: next } = redeem(rc({ idempotencyKey: 'b1' }), {
      clock: at('2026-06-29T23:59:59.999Z'),
      links: [link],
    });
    expect(next.status).toBe('completed');
  });

  it('exactly AT the boundary redemption is rejected (LINK_EXPIRED)', () => {
    expectCode(
      () => redeem(rc({ idempotencyKey: 'b2' }), { clock: at(EXP), links: [expiring()] }),
      'LINK_EXPIRED',
    );
  });

  it('redemption is rejected even when only the stored row was not yet flipped (effectiveStatus)', () => {
    // stored status is still 'active' — the clock alone decides
    const link = expiring();
    expect(link.status).toBe('active');
    expectCode(
      () => redeem(rc({ idempotencyKey: 'b3' }), { clock: at('2026-07-01T00:00:00.000Z'), links: [link] }),
      'LINK_EXPIRED',
    );
  });
});

// --- resolution by token ------------------------------------------------------------

describe('redeem — token resolves exactly one link', () => {
  it('finds the right link among many purely by token', () => {
    const a = createLink(cmd(), deps('TokenForOrgA-00001')).link;
    const b = createLink(cmd(), deps('TokenForOrgB-00001')).link;
    const { redemption } = redeem(rc({ token: 'TokenForOrgB-00001', idempotencyKey: 'pick-b' }), {
      clock: at(T0),
      links: [a, b],
    });
    expect(redemption.linkId).toBe(b.linkId);
  });
});

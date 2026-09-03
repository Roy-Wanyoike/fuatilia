/**
 * Redemption — the ONLY resolution path for a payment link (issue #21, SPEC §28).
 *
 * A customer never "looks up" a link: whoever holds the token presents it and
 * `redeem` resolves the link BY TOKEN alone. Rules enforced here:
 *
 *  - Redeemability (pure, injected clock): link must be `active` and strictly
 *    before `config.expiresAt` (effectiveStatus — expiry at the boundary is
 *    already expired). expired/disabled/cancelled/completed reject redemption
 *    with their own stable codes; a consumed single-use link answers
 *    LINK_ALREADY_REDEEMED.
 *  - Amount rules: !allowPartial ⇒ the exact remaining target; allowPartial ⇒
 *    any amount up to the remaining target (fixed) or within the open-mode
 *    [min, max] bounds; Σ redemptions can never overshoot a fixed target.
 *  - **Idempotent redemption (R9 style):** unique(linkId, idempotencyKey). A
 *    retry with the same key returns the ORIGINAL redemption/intent unchanged
 *    and emits `paymentlink.duplicateRedemptionObserved` — the duplicate is
 *    observed, never re-processed. Same key + different amount is tampering
 *    (LINK_REDEMPTION_AMOUNT_MISMATCH), not a benign retry.
 *  - Completion: full amount reached (fixed target met, or a single-use link
 *    consumed) flips the link to `completed` and emits `paymentlink.completed`
 *    after `paymentlink.redeemed`.
 *  - Every accepted redemption emits a typed `paymentlink.redeemed` event
 *    carrying the payment INTENT (intentId, amountMinor, currency, opaque
 *    refs) — the hand-off the payments lane consumes.
 */
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  paymentLinkCompletedEvent,
  paymentLinkDuplicateRedemptionObservedEvent,
  paymentLinkRedeemedEvent,
} from './events';
import type { PaymentLinkEvent } from './events';
import { effectiveStatus, remainingTargetMinor, uuidFromSeed } from './link';
import type { LinkStatus, PaymentLink } from './link';

export interface RedeemCommand {
  readonly token: string; // the secret — resolution is by token ONLY
  readonly idempotencyKey: string; // unique(linkId, idempotencyKey) — R9
  readonly amount: Money;
  readonly intentId?: Uuid; // caller-supplied payment-intent id (preferred); deterministic fallback
}

export interface RedemptionRecord {
  readonly redemptionId: Uuid;
  readonly linkId: Uuid;
  readonly intentId: Uuid; // payment intent for the payments lane (opaque)
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly redeemedAt: Date;
}

export interface RedeemContext {
  readonly clock: Clock;
  readonly links?: readonly PaymentLink[]; // links known to this process — resolved by token
  readonly redemptions?: readonly RedemptionRecord[]; // prior redemptions, for idempotency
}

export interface RedeemResult {
  readonly link: PaymentLink; // the link AFTER the redemption (unchanged on duplicates)
  readonly redemption: RedemptionRecord; // the original on duplicates — never re-processed
  readonly duplicate: boolean;
  readonly events: readonly PaymentLinkEvent[];
}

const assertPositive = (amount: Money): void => {
  if (amount.amount <= 0n) {
    throw new DomainError('AMOUNT_MUST_BE_POSITIVE', 'redemption amounts must be > 0');
  }
};

const assertSameCurrency = (link: PaymentLink, amount: Money): void => {
  if (amount.currency !== link.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `cannot redeem ${amount.currency} against a ${link.currency} link (R10)`,
    );
  }
};

const rejectStatus = (link: PaymentLink, status: LinkStatus): never => {
  const code =
    status === 'expired'
      ? 'LINK_EXPIRED'
      : status === 'disabled'
        ? 'LINK_DISABLED'
        : status === 'cancelled'
          ? 'LINK_CANCELLED'
          : link.config.singleUse
            ? 'LINK_ALREADY_REDEEMED'
            : 'LINK_COMPLETED';
  throw new DomainError(code, `payment link ${link.linkId} is ${status} and cannot be redeemed`);
};

const assertAmount = (link: PaymentLink, amount: Money): void => {
  if (link.targetAmountMinor !== undefined) {
    const remaining = remainingTargetMinor(link)!;
    if (!link.config.allowPartial) {
      if (!amount.equals(remaining)) {
        throw new DomainError(
          'LINK_AMOUNT_EXACT_REQUIRED',
          `this link accepts only the exact target ${remaining.toString()}; got ${amount.toString()}`,
        );
      }
      return;
    }
    if (amount.compareTo(remaining) > 0) {
      throw new DomainError(
        'LINK_AMOUNT_EXCEEDS_TARGET',
        `partial redemption ${amount.toString()} would overshoot the remaining target ${remaining.toString()}`,
      );
    }
    return;
  }
  const { minAmountMinor, maxAmountMinor } = link;
  if (minAmountMinor && amount.compareTo(minAmountMinor) < 0) {
    throw new DomainError(
      'LINK_AMOUNT_BELOW_MIN',
      `redemption ${amount.toString()} is below the link minimum ${minAmountMinor.toString()}`,
    );
  }
  if (maxAmountMinor && amount.compareTo(maxAmountMinor) > 0) {
    throw new DomainError(
      'LINK_AMOUNT_ABOVE_MAX',
      `redemption ${amount.toString()} is above the link maximum ${maxAmountMinor.toString()}`,
    );
  }
};

/**
 * Redeem a payment link by token. Duplicate-safe (R9), boundary-exact on
 * expiry, and the single gateway from a shared token to a payment intent.
 */
export const redeem = (cmd: RedeemCommand, ctx: RedeemContext): RedeemResult => {
  const token = cmd.token.trim();
  if (!token) {
    throw new DomainError('LINK_TOKEN_REQUIRED', 'a link token is required to redeem');
  }
  const idempotencyKey = cmd.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new DomainError('LINK_IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required (R9)');
  }
  assertPositive(cmd.amount);

  // Secure tokenization: resolution is BY TOKEN, the only path into a link.
  const link = (ctx.links ?? []).find((l) => l.token === token);
  if (!link) {
    throw new DomainError('LINK_NOT_FOUND', 'no payment link matches the presented token');
  }

  // R9: a duplicate is the SAME logical redemption — return the original
  // intent unchanged and observe (never re-process) the retry.
  const prior = (ctx.redemptions ?? []).find(
    (r) => r.linkId === link.linkId && r.idempotencyKey === idempotencyKey,
  );
  if (prior) {
    if (!prior.amount.equals(cmd.amount)) {
      throw new DomainError(
        'LINK_REDEMPTION_AMOUNT_MISMATCH',
        `retry for key ${idempotencyKey} carries ${cmd.amount.toString()} but the original redemption was ${prior.amount.toString()}`,
      );
    }
    return {
      link,
      redemption: prior,
      duplicate: true,
      events: [
        paymentLinkDuplicateRedemptionObservedEvent(
          { linkId: link.linkId, idempotencyKey, intentId: prior.intentId, seenAt: ctx.clock.now() },
          ctx.clock,
        ),
      ],
    };
  }

  const now = ctx.clock.now();
  const status = effectiveStatus(link, now);
  if (status !== 'active') {
    rejectStatus(link, status);
  }

  assertSameCurrency(link, cmd.amount);
  assertAmount(link, cmd.amount);

  const redeemedTotal = link.redeemedTotalMinor.add(cmd.amount);
  const targetMet =
    link.targetAmountMinor !== undefined && redeemedTotal.equals(link.targetAmountMinor);
  const completes = link.config.singleUse || targetMet;
  const intentId = cmd.intentId ?? uuidFromSeed(`payment-intent:${link.linkId}:${idempotencyKey}`);
  const redemption: RedemptionRecord = {
    redemptionId: uuidFromSeed(`plink-redemption:${link.linkId}:${idempotencyKey}`),
    linkId: link.linkId,
    intentId,
    amount: cmd.amount,
    idempotencyKey,
    redeemedAt: now,
  };
  const nextLink: PaymentLink = {
    ...link,
    status: completes ? 'completed' : 'active',
    redeemedTotalMinor: redeemedTotal,
    redemptionCount: link.redemptionCount + 1,
    ...(completes ? { completedAt: now } : {}),
  };
  const events: PaymentLinkEvent[] = [
    paymentLinkRedeemedEvent(
      {
        linkId: link.linkId,
        intentId,
        amountMinor: cmd.amount.amount,
        currency: cmd.amount.currency,
        redeemedAt: now,
      },
      ctx.clock,
    ),
  ];
  if (completes) {
    events.push(
      paymentLinkCompletedEvent(
        { linkId: link.linkId, collectedMinor: redeemedTotal.amount, completedAt: now },
        ctx.clock,
      ),
    );
  }
  return { link: nextLink, redemption, duplicate: false, events };
};

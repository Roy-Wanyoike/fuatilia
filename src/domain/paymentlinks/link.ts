/**
 * PaymentLink aggregate — a secure, shareable collection link (issue #21, SPEC §28).
 *
 * Rules enforced here:
 *  - Pure functions only; time comes from an injected Clock, ids from callers
 *    (or deterministic derivation) — never Date.now()/RNG (see uuidFromSeed).
 *  - **Secure tokenization:** the token comes from an INJECTED generator
 *    (`deps.generateToken`) — the domain stays pure and never sees randomness.
 *    The token is opaque: the lane never mixes command data into it, never
 *    encodes/decodes it, and gates its shape (URL-safe, bounded length) so no
 *    structured data (emails, phones, JSON) can ride inside. It is a secret:
 *    it is never mirrored into event payloads, and `redeem` is the ONLY
 *    resolution path by token.
 *  - Money only via `Money` (minor units, bigint) — floats are banned (R10).
 *  - Exactly one amount mode: FIXED (`targetAmountMinor`) or OPEN (optional
 *    `minAmountMinor`/`maxAmountMinor` bounds) — never both, never neither.
 *  - Lifecycle (docs/05): active | expired | completed | disabled | cancelled.
 *    `active` is the only live state; admin disable/cancel apply from `active`
 *    only; expiry is time-driven (`effectiveStatus` / `expireIfDue`); completion
 *    is earned by redemption (redeem.ts). Terminal states reject everything.
 */
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import {
  paymentLinkCancelledEvent,
  paymentLinkCreatedEvent,
  paymentLinkDisabledEvent,
  paymentLinkExpiredEvent,
} from './events';
import type { PaymentLinkEvent } from './events';

/** docs/05 data dictionary lifecycle. */
export type LinkStatus = 'active' | 'expired' | 'completed' | 'disabled' | 'cancelled';

/** Terminal states — nothing transitions out of them. */
export const LINK_TERMINAL_STATES: readonly LinkStatus[] = [
  'expired',
  'completed',
  'disabled',
  'cancelled',
];

export interface LinkConfig {
  readonly singleUse: boolean; // one successful redemption consumes the link
  readonly allowPartial: boolean; // amounts below the target are accepted
  readonly expiresAt?: Date; // inclusive boundary: redeemable strictly BEFORE this instant
}

export interface PaymentLink {
  readonly linkId: Uuid;
  readonly orgId: Uuid; // opaque — owning organization
  readonly token: string; // opaque secret; injected generator; never encodes PII
  readonly receivableIds: readonly Uuid[]; // opaque — receivables are another lane
  readonly currency: Currency;
  readonly targetAmountMinor?: Money; // fixed mode
  readonly minAmountMinor?: Money; // open mode bounds (either/both)
  readonly maxAmountMinor?: Money;
  readonly config: LinkConfig;
  readonly status: LinkStatus;
  readonly redeemedTotalMinor: Money; // Σ accepted redemptions
  readonly redemptionCount: number;
  readonly createdAt: Date;
  readonly completedAt?: Date;
  readonly expiredAt?: Date;
  readonly disabledAt?: Date;
  readonly cancelledAt?: Date;
}

export interface CreateLinkCommand {
  readonly orgId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly currency: Currency;
  readonly targetAmountMinor?: Money; // fixed mode
  readonly minAmountMinor?: Money; // open mode bounds
  readonly maxAmountMinor?: Money;
  readonly config: LinkConfig;
  readonly linkId?: Uuid; // caller-supplied (preferred); deterministic fallback otherwise
}

/** Port for secure tokenization — the adapter supplies entropy, the domain stays pure. */
export type TokenGenerator = () => string;

export interface LinkCreationDeps {
  readonly clock: Clock;
  readonly generateToken: TokenGenerator;
}

export interface LinkCreationResult {
  readonly link: PaymentLink;
  readonly events: readonly PaymentLinkEvent[];
}

/* ------------------------------------------------------------------ *
 * Lane id helper (mirrors payments/ids.ts — lanes never import lanes).
 * Deterministic UUID-shaped id from a seed string, so replaying the
 * same logical command yields the same id (idempotent replay bonus).
 * ------------------------------------------------------------------ */
const FNV_OFFSET = 0x811c9dc5n;
const FNV_PRIME = 0x01000193n;
const WORD_MASK = 0xffffffffn;

const fnv1a32 = (round: number, input: string): bigint => {
  let hash = FNV_OFFSET ^ BigInt(round);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & WORD_MASK;
  }
  return hash;
};

/** Deterministic UUID-shaped id (8-4-4-4-12 hex) derived from a seed. Pure. */
export const uuidFromSeed = (seed: string): Uuid => {
  const w = (round: number): string => fnv1a32(round, seed).toString(16).padStart(8, '0');
  const raw = `${w(0)}-${w(1).slice(0, 4)}-${w(1).slice(4, 8)}-${w(2).slice(0, 4)}-${w(2).slice(4, 8)}${w(3)}`;
  return uuid(raw);
};

/**
 * Token shape gate (the privacy half of secure tokenization). The token is
 * URL-safe base64url-ish and bounded; anything that could carry structured
 * data — emails ('@', '.'), phones ('+'), JSON ('{', '"', ':'), whitespace,
 * separators, padding ('=') — is rejected. The domain never inspects the
 * token's meaning; it only refuses shapes that could smuggle one.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const assertTokenShape = (token: string): void => {
  if (!TOKEN_PATTERN.test(token)) {
    throw new DomainError(
      'LINK_TOKEN_MALFORMED',
      'link token must be 16-128 URL-safe characters ([A-Za-z0-9_-]); structured or PII-shaped tokens are rejected',
    );
  }
};

export const linkAmountMode = (link: PaymentLink): 'fixed' | 'open' =>
  link.targetAmountMinor !== undefined ? 'fixed' : 'open';

/** Σ collectible so far vs the fixed target (undefined for open links). */
export const remainingTargetMinor = (link: PaymentLink): Money | undefined =>
  link.targetAmountMinor && link.targetAmountMinor.subtract(link.redeemedTotalMinor);

/**
 * Time-aware view of the lifecycle (docs/05): an `active` link whose
 * `config.expiresAt` instant has been reached reads as `expired` even before
 * a sweeper persists the flip. The boundary is INCLUSIVE: a link is
 * redeemable strictly before `expiresAt`, never at or after it.
 */
export const effectiveStatus = (link: PaymentLink, now: Date): LinkStatus => {
  const expiry = link.config.expiresAt;
  if (link.status === 'active' && expiry && now.getTime() >= expiry.getTime()) return 'expired';
  return link.status;
};

const assertActive = (link: PaymentLink, op: string): void => {
  if (link.status !== 'active') {
    throw new DomainError(
      'LINK_TRANSITION_INVALID',
      `cannot ${op} a payment link in status ${link.status}; only active links can be ${op}d`,
    );
  }
};

const assertReason = (reason: string, op: string): string => {
  const why = reason.trim();
  if (!why) {
    throw new DomainError('LINK_REASON_REQUIRED', `a ${op} transition requires an explicit reason (R3)`);
  }
  return why;
};

/**
 * Create a payment link. The token is whatever the injected generator returns,
 * byte-for-byte: the domain never derives, decorates, or encodes it.
 */
export const createLink = (cmd: CreateLinkCommand, deps: LinkCreationDeps): LinkCreationResult => {
  const receivableIds: Uuid[] = [];
  for (const raw of cmd.receivableIds) {
    if (!receivableIds.includes(raw)) receivableIds.push(raw);
  }
  if (receivableIds.length === 0) {
    throw new DomainError('LINK_RECEIVABLE_REQUIRED', 'a payment link must reference at least one receivable');
  }

  const fixed = cmd.targetAmountMinor !== undefined;
  const bounded = cmd.minAmountMinor !== undefined || cmd.maxAmountMinor !== undefined;
  if (fixed && bounded) {
    throw new DomainError(
      'LINK_AMOUNT_MODE_CONFLICT',
      'a link is either fixed-target or open-amount with bounds — never both',
    );
  }
  if (fixed) {
    const target = cmd.targetAmountMinor!;
    if (target.amount <= 0n) {
      throw new DomainError('LINK_TARGET_INVALID', 'the fixed target must be > 0');
    }
  }
  for (const bound of [cmd.minAmountMinor, cmd.maxAmountMinor]) {
    if (bound && bound.amount <= 0n) {
      throw new DomainError('LINK_BOUNDS_INVALID', 'open-amount bounds must be > 0');
    }
  }
  if (cmd.minAmountMinor && cmd.maxAmountMinor && cmd.minAmountMinor.compareTo(cmd.maxAmountMinor) > 0) {
    throw new DomainError('LINK_BOUNDS_INVALID', 'minAmountMinor cannot exceed maxAmountMinor');
  }

  const createdAt = deps.clock.now();
  const expiresAt = cmd.config.expiresAt;
  if (expiresAt && expiresAt.getTime() <= createdAt.getTime()) {
    throw new DomainError('LINK_EXPIRY_INVALID', 'expiresAt must be strictly in the future');
  }

  const token = deps.generateToken();
  assertTokenShape(token);

  const link: PaymentLink = {
    linkId: cmd.linkId ?? uuidFromSeed(`paymentlink:${cmd.orgId}:${token}`),
    orgId: cmd.orgId,
    token,
    receivableIds,
    currency: cmd.currency,
    ...(fixed ? { targetAmountMinor: cmd.targetAmountMinor } : {}),
    ...(cmd.minAmountMinor !== undefined ? { minAmountMinor: cmd.minAmountMinor } : {}),
    ...(cmd.maxAmountMinor !== undefined ? { maxAmountMinor: cmd.maxAmountMinor } : {}),
    config: cmd.config,
    status: 'active',
    redeemedTotalMinor: Money.zero(cmd.currency),
    redemptionCount: 0,
    createdAt,
  };
  return {
    link,
    events: [
      paymentLinkCreatedEvent(
        {
          linkId: link.linkId,
          orgId: link.orgId,
          receivableIds: link.receivableIds,
          mode: fixed ? 'fixed' : 'open',
          ...(fixed && cmd.targetAmountMinor ? { targetAmountMinor: cmd.targetAmountMinor.amount } : {}),
          ...(cmd.minAmountMinor ? { minAmountMinor: cmd.minAmountMinor.amount } : {}),
          ...(cmd.maxAmountMinor ? { maxAmountMinor: cmd.maxAmountMinor.amount } : {}),
          currency: link.currency,
          singleUse: link.config.singleUse,
          allowPartial: link.config.allowPartial,
          ...(expiresAt ? { expiresAt } : {}),
        },
        deps.clock,
      ),
    ],
  };
};

export interface LinkTransitionResult {
  readonly link: PaymentLink;
  readonly events: readonly PaymentLinkEvent[];
}

/**
 * Time-driven expiry (docs/05 active → expired). A sweeper calls this; if the
 * boundary instant has been reached the link flips with `paymentlink.expired`.
 * Idempotent: not due, no expiry, or already terminal → unchanged, no events.
 */
export const expireIfDue = (link: PaymentLink, clock: Clock): LinkTransitionResult => {
  const expiry = link.config.expiresAt;
  const now = clock.now();
  if (link.status !== 'active' || !expiry || now.getTime() < expiry.getTime()) {
    return { link, events: [] };
  }
  return {
    link: { ...link, status: 'expired', expiredAt: now },
    events: [paymentLinkExpiredEvent({ linkId: link.linkId, expiredAt: now }, clock)],
  };
};

/** Admin: active → disabled. Disabled links reject redemption; disabled is terminal. */
export const disableLink = (link: PaymentLink, reason: string, clock: Clock): LinkTransitionResult => {
  assertActive(link, 'disable');
  const why = assertReason(reason, 'disable');
  const disabledAt = clock.now();
  return {
    link: { ...link, status: 'disabled', disabledAt },
    events: [paymentLinkDisabledEvent({ linkId: link.linkId, reason: why, disabledAt }, clock)],
  };
};

/** Admin: active → cancelled. Cancelled links reject redemption. */
export const cancelLink = (link: PaymentLink, reason: string, clock: Clock): LinkTransitionResult => {
  assertActive(link, 'cancel');
  const why = assertReason(reason, 'cancel');
  const cancelledAt = clock.now();
  return {
    link: { ...link, status: 'cancelled', cancelledAt },
    events: [paymentLinkCancelledEvent({ linkId: link.linkId, reason: why, cancelledAt }, clock)],
  };
};

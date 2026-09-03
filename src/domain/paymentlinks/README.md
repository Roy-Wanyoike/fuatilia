# Payment links lane — wave 3 (issue #21, SPEC §28)

Owns secure payment links: a shareable, tokenized way to collect against
receivables with **expiration, single-use configuration, partial/full payment,
and secure tokenization** (SPEC §28). `redeem` is the single gateway from a
held token to a typed **payment intent** the payments lane can process.

## Scope

- `PaymentLink` aggregate — `linkId`, `orgId` (opaque), `token` (opaque
  secret), `receivableIds` (opaque), `currency`, exactly one amount mode:
  - **fixed** — `targetAmountMinor` (collect a precise amount), or
  - **open** — `minAmountMinor` / `maxAmountMinor` bounds (pay what you owe,
    within bounds);
  plus `config { singleUse, allowPartial, expiresAt? }` and `status`.
- Lifecycle (docs/05; `active` is the only live state):

  ```text
  active    → completed  (full amount reached, or single-use consumed)
  active    → expired    (time-driven: at/after config.expiresAt — inclusive boundary)
  active    → disabled   (admin, reason mandatory)
  active    → cancelled  (admin, reason mandatory)
  expired | completed | disabled | cancelled   ← terminal, nothing re-opens them
  ```

  `effectiveStatus(link, now)` gives the time-aware view (an active link at or
  past its boundary reads `expired` even before a sweeper persists the flip);
  `expireIfDue` performs the persisted transition and emits the event.
- **Secure tokenization (the core):**
  - `createLink(cmd, { clock, generateToken })` — the token generator is
    INJECTED, so the domain core stays pure (no RNG, no `Date.now()`).
  - The token is **opaque**: the lane never derives, decorates, or encodes it;
    command data is never mixed into it; two identical commands with a
    normal generator get different tokens.
  - Shape gate (`LINK_TOKEN_MALFORMED`): 16–128 URL-safe `[A-Za-z0-9_-]`
    characters — emails, phones, JSON, whitespace, and separator/padding
    shapes are structurally rejected, so no PII can ride inside a token.
  - The token is a **secret**: never mirrored into event payloads, and
    `redeem` is the ONLY resolution path (by token — no lookup by org,
    receivable, or customer data).
- Redemption rules (`redeem.ts`, pure; clock injected):
  - link must be `active` and strictly before `expiresAt`;
    expired/disabled/cancelled/completed reject with their own stable codes;
    a consumed single-use link answers `LINK_ALREADY_REDEEMED`;
  - `!allowPartial` ⇒ exact remaining target (`LINK_AMOUNT_EXACT_REQUIRED`);
    `allowPartial` ⇒ up to the remaining target (`LINK_AMOUNT_EXCEEDS_TARGET`)
    or within the open-mode `[min, max]` bounds (`LINK_AMOUNT_BELOW_MIN` /
    `LINK_AMOUNT_ABOVE_MAX`); a fixed target can never be overshot;
  - full amount reached (target met, or single-use consumed) ⇒ `completed`,
    emitting `paymentlink.completed` after `paymentlink.redeemed`;
  - **idempotent redemption (R9 style):** unique(`linkId`, `idempotencyKey`) —
    a retry with the same key returns the ORIGINAL redemption/intent unchanged
    and emits `paymentlink.duplicateRedemptionObserved`; the duplicate is
    observed, never re-processed. Same key with a different amount is
    tampering (`LINK_REDEMPTION_AMOUNT_MISMATCH`), not a retry.
- Lane events (`events.ts`, repo naming `<context>.<aggregate><PastTenseVerb>`):
  `paymentlink.created`, `paymentlink.redeemed`, `paymentlink.completed`,
  `paymentlink.expired`, `paymentlink.disabled`, `paymentlink.cancelled`, plus
  the R9 tripwire `paymentlink.duplicateRedemptionObserved`.
  `paymentlink.redeemed` carries the intent payload (`intentId`, `amountMinor`,
  `currency`, `redeemedAt`) — the hand-off for the payments lane; ids are
  opaque throughout.

## Rules

- Import ONLY from `../shared`. Receivables (and the payments lane that
  consumes intents) are referenced by opaque `Uuid` ids; no cross-lane imports.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`, entropy from the injected `TokenGenerator`; aggregates are
  immutable, operations return fresh copies.
- Money only via `Money` (minor units, bigint) — floats banned (R10);
  redemptions are single-currency against the link's currency (`CURRENCY_MISMATCH`).
- Stable `DomainError` codes (SCREAMING_SNAKE, `LINK_*` prefix):
  `LINK_TOKEN_REQUIRED`, `LINK_TOKEN_MALFORMED`, `LINK_RECEIVABLE_REQUIRED`,
  `LINK_AMOUNT_MODE_CONFLICT`, `LINK_TARGET_INVALID`, `LINK_BOUNDS_INVALID`,
  `LINK_EXPIRY_INVALID`, `LINK_REASON_REQUIRED`, `LINK_TRANSITION_INVALID`,
  `LINK_NOT_FOUND`, `LINK_IDEMPOTENCY_KEY_REQUIRED`, `LINK_EXPIRED`,
  `LINK_DISABLED`, `LINK_CANCELLED`, `LINK_COMPLETED`, `LINK_ALREADY_REDEEMED`,
  `LINK_AMOUNT_EXACT_REQUIRED`, `LINK_AMOUNT_EXCEEDS_TARGET`,
  `LINK_AMOUNT_BELOW_MIN`, `LINK_AMOUNT_ABOVE_MAX`,
  `LINK_REDEMPTION_AMOUNT_MISMATCH`; shared `AMOUNT_MUST_BE_POSITIVE`,
  `CURRENCY_MISMATCH`.

## Definition of done

- Table-driven tests: creation (both modes + every refusal), token privacy
  (verbatim from the generator, shape gate, never in payloads), lifecycle
  transitions incl. the expiry boundary via fake clocks, redemption amount
  tables, double-redeem rejection, idempotent redemption (original intent
  returned, duplicate observed), event envelope shape.
- `npm run typecheck && npm test` green.

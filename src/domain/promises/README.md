# Promises module — wave 3 (issue #19)

Owns the Promise-to-Pay (K2): the customer's recorded commitment to pay by a
promised date, its settlement-driven lifecycle, and the pure dunning cadence
engine (SPEC §10 + §18).

## Scope
- `PromiseToPay` — amountMinor + currency, promised date, source
  (`whatsapp | sms | call | portal`), optional opaque `consentRef`, status.
  Lifecycle (SPEC §10): `created → pending → partially_fulfilled | fulfilled |
  broken | cancelled | expired` — table-driven, see `PROMISE_TRANSITIONS`.
- **Settlement-driven transitions** (data-in/data-out): full coverage →
  `fulfilled`; partial → `partially_fulfilled`; over-coverage is refused,
  never truncated. Past the promised date without full coverage → `broken`
  (emits `promise.broken` + catalog E27 `collections.promiseBroken`, the
  collections-workflow trigger).
- **Expiry**: promisedDate + grace days (default 7) with zero coverage and no
  break verdict → `expired`. Partially covered promises break, they never
  quietly expire.
- **Dunning orchestration** (`dunning.ts`): the SPEC §18 ladder
  (pre-due −3 → due 0 → +3/+7/+14/+30/+45/+60) as pure CONFIGURATION
  (`DEFAULT_DUNNING_LADDER`, replaceable), `dueSteps(now, facts)` selection
  with sentSteps idempotence, the K2 consent gate
  (`assertDunningSendable` throws stable `DUNNING_CONSENT_REQUIRED`;
  `orchestrateDunning` returns blocked steps carrying the
  `collections.dunningBlockedNoConsent` fact so refusals are observable),
  and facts-driven no-response escalation (`escalationDue` +
  `dunning.escalated`).

## Rules
- Import ONLY from `../shared`. Cross-lane ids (customer, receivables, consent
  grant, collections case) are opaque `Uuid`s/refs — never dereferenced here.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`; dunning day arithmetic is UTC-day-index based so day
  boundaries are deterministic.
- Stable `DomainError` codes (`PROMISE_*` / `DUNNING_*` prefix) for invalid
  input and illegal transitions; the consent refusal is both a value
  (`evaluateDunningSend`) and an exception (`assertDunningSendable`).
- Events in repo naming style (`promise.*`, `dunning.*`) plus the two
  catalog facts `collections.promiseBroken` (E27) and
  `collections.dunningBlockedNoConsent` — see `../events/README.md`.

## Definition of done
- Full transition grid (legal + illegal), settlement coverage table, broken/
  expiry day boundaries via fake clock, consent-blocked sends, cadence day
  boundaries and escalation windows — all table-driven tested.
- `npm run typecheck && npm test` green.

# USSD lane — wave 7 (issue #54, SPEC §31)

Owns the pure session/menu state machine for customers on **feature phones** —
the "do not assume every customer has a smartphone" channel. Dial in, walk a
menu, get an answer, hang up. Channel transport (the GSM gateway, the
string-shuffling, the timeouts on the wire) is an adapter concern; this lane is
deterministic domain logic over plain data.

```text
dial-in → sessionStarted → menu graph walk (respond) → §31 flow over a port → screen + events → ended | expired | aborted
```

## Scope

- **`menu.ts`** — the menu graph is pure CONFIGURATION (policy-lane precedent:
  rule sets are data, so are menus). `UssdMenuNode` = `nodeKey`, `textKey`
  (i18n KEY — a display string in this lane is a bug), `options` (1–2 digit
  keys → another node, or one of the five flow actions with static per-option
  args), `isRoot`, `terminal`. `assertMenuGraph` is the only constructor:
  unique nodeKeys, every target resolves, exactly one root, every node
  reachable from the root, every reachable node can EXIT (a terminal node or
  any flow option en route — refuses orphan cycles and dead ends), and every
  node's static screen fits the budget. Returns a deep-frozen graph; the
  default budget is 182 chars (the classic ~3×40 feature-phone screen);
  `#` (abort) and the `backKey` (default `0`) are reserved — options may
  never shadow them.
- **`session.ts`** — `UssdSession` (sessionId, orgId, customerId opaque,
  normalized E.164 `+254` MSISDN, state, currentNodeKey, append-only
  inputHistory, ttlMs, createdAt/lastActiveAt/expiresAt). Lifecycle
  `started → active → ended | expired | aborted`; the first processed input
  activates. Idle TTL via the injected Clock (default 180s), boundary
  INCLUSIVE (`now < expiresAt` is usable), refreshed by every processed
  input. `respond(session, input, now, graph, flows?)` → deterministic
  `UssdStep`: navigation | re-prompt (`USSD_INPUT_INVALID` as a VALUE — a
  wrong key is a customer event) | flow dispatch | expired | end. `#` aborts
  from anywhere; back-nav replays inputHistory against the graph, so it is
  correct even in multi-parent graphs. Every step returns the next screen
  AND emits its event(s) off ONE Clock read. The sweeper
  `expireUssdSession` and explicit `endUssdSession` mirror the auth-lane
  shape.
- **`flows.ts`** — the five §31 flows (`balance_query`, `invoice_list`,
  `statement_query`, `plan_request`, `payment_handoff`) over injected
  READ-ONLY capability PORTS (plain functions, plain data — declared in this
  lane, implemented by adapters later). Every available answer MUST carry a
  non-blank `evidenceRef`; malformed answers (negative amounts, unknown
  currencies, missing evidence, unparseable dates) are refused. Flow
  failures are VALUES + `ussd.flowFailed` events, never throws; a throwing
  port is captured as unavailability. The lane performs NO money arithmetic
  (R1/R2): amounts are validated through the shared `Money` value object and
  rendered to display strings. The plan flow relays an intent RECORD (plan
  truth stays in the plans lane); the handoff flow relays a descriptor
  (payment intake stays in the payments lane). An over-budget answer is
  DEMOTED to `USSD_SCREEN_OVERBUDGET` — a wrong number is never shown just
  because it fits.
- **`events.ts`** — `ussd.sessionStarted / .navigated / .inputRejected /
  .flowCompleted / .flowFailed / .sessionEnded / .sessionExpired /
  .sessionAborted`, repo envelope `{ name, version: 1, aggregateId, payload,
  occurredAt }`; every fact aggregates the session id.

## PII boundary (pinned by test)

The MSISDN never enters any event, error message or log line — events carry
opaque ids, node keys, flow names, stable codes and the `evidenceRef`.
Financial answers (amounts, invoice numbers, statement refs) stay on the
returned RESULT for the screen; events prove THAT an answer was given and
which evidence backs it, not what it said. `normalizeMsisdn` failures report
only the input's LENGTH.

## Screen budget

`screenCost(screen) = textKey.length + Σ (paramKey.length + String(value).length)`
— the deterministic proxy for rendered length over the material this lane
sees (the adapter's locale catalog owns the final render). Menus are
validated statically (prompt + option labels); flow answers are checked at
respond time.

## Ports (read-only; adapters implement)

| Port | Returns | Guard rails |
|---|---|---|
| `BalanceQuery` | `amountMinor` + `Currency` | safe non-negative int, known currency |
| `InvoiceListQuery` | invoice rows (id, number, due amount, due date) | rows fully validated even past the display `limit` (default 3) |
| `StatementQuery` | statementRef, period bounds, invoiced/paid totals | ISO dates, non-negative totals |
| `PlanRequestPort` | plan intent record (`planIntentId`, optional receivableId) | relays intent; never writes plan/fund truth |
| `PaymentHandoffPort` | handoff descriptor (`handoffRef`, optional invoiceId, payBy) | relays; payment intake stays in the payments lane |

Every port answers `UssdPortAnswer<T>`: `{ available: true, data, evidenceRef }`
or `{ available: false, reason }` → `USSD_FLOW_UNAVAILABLE`.

## Events (`ussd.*`, envelope `{ name, version: 1, aggregateId, payload, occurredAt }`)

`ussd.sessionStarted`, `ussd.navigated`, `ussd.inputRejected`,
`ussd.flowCompleted`, `ussd.flowFailed`, `ussd.sessionEnded`,
`ussd.sessionExpired`, `ussd.sessionAborted`. Aggregate convention: every
fact is session-scoped → the session id. `occurredAt` is the step's single
injected instant (one Clock read per step → bit-for-bit deterministic
replays).

## Stable codes

`USSD_MSISDN_INVALID`, `USSD_TTL_INVALID`, `USSD_CLOCK_INVALID`,
`USSD_SESSION_ID_REQUIRED`, `USSD_ORG_REQUIRED`, `USSD_CUSTOMER_REQUIRED`,
`USSD_ROOT_KEY_REQUIRED`, `USSD_REASON_REQUIRED`, `USSD_SESSION_NOT_ACTIVE`,
`USSD_SESSION_NOT_DUE`, `USSD_INPUT_INVALID`, `USSD_MENU_NODE_UNKNOWN`;
menu — `USSD_MENU_EMPTY`, `USSD_MENU_NODE_INVALID`, `USSD_MENU_NODE_DUPLICATE`,
`USSD_MENU_TARGET_UNKNOWN`, `USSD_MENU_ROOT_REQUIRED`, `USSD_MENU_ROOT_DUPLICATE`,
`USSD_MENU_UNREACHABLE`, `USSD_MENU_DEAD_END`, `USSD_MENU_SCREEN_OVERBUDGET`,
`USSD_MENU_KEY_RESERVED`, `USSD_MENU_OPTION_DUPLICATE`, `USSD_MENU_FLOW_UNKNOWN`,
`USSD_MENU_BACKKEY_INVALID`, `USSD_MENU_BUDGET_INVALID`; flows —
`USSD_FLOW_UNAVAILABLE`, `USSD_FLOW_NOT_WIRED`, `USSD_FLOW_PORT_MALFORMED`,
`USSD_FLOW_EVIDENCE_REQUIRED`, `USSD_FLOW_LIMIT_INVALID`,
`USSD_SCREEN_OVERBUDGET`.

Two-tier contract: adapter bugs throw these as `DomainError` (dead session
routed to `respond`, non-string input, broken clock, malformed graph);
customer outcomes never throw — wrong keys are re-prompt values, flow
failures are values + events.

## Rules

- Import ONLY from `../shared` + this lane. `customerId`, `invoiceId`,
  `receivableId` are opaque `Uuid`s; capability data arrives via the ports —
  no receivables/payments/plans imports, ever.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time via the
  injected `Clock` (one read per step; every event of the step shares it).
- Fresh immutable copies on every transition; graphs and answers are
  deep-frozen; inputs are never mutated.
- Deny-by-default: unknown keys re-prompt, malformed capability answers are
  refused, over-budget answers are demoted, reserved keys are unshadowable.

## Deviations (deliberate, documented)

- `ussd.inputRejected` is ADDITIVE beyond the issue's event list (precedent:
  `webhook.deliveryRefused`) — the "every step emits an event" invariant
  needs a fact for the re-prompt step.
- The five default flows END the session after their result/failure screen
  (classic USSD "thank you" semantics); a customer who wants more dials in
  again. Navigational composition is the menu graph's job.
- Inputs are capped at 8 chars (truncated before processing/history/events)
  — USSD keys are tiny; the cap bounds state and keeps events narrow.
- Catalog registration for `ussd.*` (docs/04) stays with the events lane
  owner, matching wave-3/4/6 precedent.

## Out of scope (issue #54)

The GSM/WASP gateway, session storage, i18n catalogs, payment intake, plan
truth, ledger truth. Consumers: the transport adapter mounts `respond`
behind its USSD callback and renders screens/locales; the payments lane
receives handoffs; the plans lane receives intents.

## Definition of done

- Table-driven specs: menu validation (uniques, targets, roots, reachability,
  dead ends, budget, reserved keys), session lifecycle (expiry ±1ms, abort,
  re-prompt idempotence, back-nav incl. multi-parent trail, determinism,
  no-mutation), all five flows happy + every error path, MSISDN
  normalization table, screen-budget enforcement, PII-free event pin.
- `npm run typecheck && npm test` green.

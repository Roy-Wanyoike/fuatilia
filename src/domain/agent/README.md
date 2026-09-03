# Agent lane — capability queries (wave 5, issue #35, VISION §3.8)

An AI agent (or human UI, or integration) asks **business questions**; Fuatilia
reasons over financial state and answers **with evidence**. This lane is the
domain capability layer the future HTTP transport will expose — the transport
itself stays deliberately deferred (SPEC §34/35).

> The intelligence layer never owns fund truth (README principle 2): every
> function here is a pure, read-only projection over facts the caller
> supplies. Executing a recommendation is other lanes' work, gated by the
> policy engine (F20) — never this module.

## Scope — three capability queries

- `financialStateOf(query, clock)` — *what is this customer's position with us,
  right now?* Per-currency exposure (bigint minor units), open receivables with
  age (same `0-30|31-60|61-90|90+` buckets as the receivables lane), the
  **disputed vs promised vs plain open** split (dispute outranks pending
  promise, per `deriveCaseStatus` precedence), last payment date, unallocated
  payments (R2 remainder) + the C4 credit balance reported **separately** (no
  double-counting), and risk-relevant behavior flags with their weights.
- `receivablePriorities(query, clock)` — *which receivables should we work
  first?* A ranked list scored by a **transparent deterministic expression**
  (no opaque scores — the formula, its constants and each item's components
  are public contract):
  `priority = agePoints(bucketIndex × AGE_POINTS_PER_BUCKET=10) + sizePoints(sizeBands) + flagPoints(FLAG_WEIGHTS) + statusPoints(disputed +12 | broken_promise +12 | promised −10 | open 0)`.
  Ties break on larger balance → older due date → receivable id — always
  deterministic. R10 currency discipline: the ranked (open) receivables must
  share ONE currency — size bands are calibrated per query and the balance
  tie-break compares balances, so a mixed set is refused
  (`AGENT_CURRENCY_MISMATCH`, the intelligence-lane precedent); closed
  receivables are history and never trip the guard. `financialStateOf` stays
  multi-currency: exposure is reported **per currency**, never summed across.
- `collectionRecommendations(query, clock)` — *what should we DO next for the
  high-priority receivables?* First-match-wins matrix over the priorities
  ranking → `offer_payment_plan | send_payment_link | human_review |
  do_nothing_yet`, each with the matched **rule id** and reasons. High
  priority = score ≥ `HIGH_PRIORITY_MIN_SCORE` (30, overridable per query) OR
  an open dispute (a contested debt always needs a decision). Matrix rules in
  order: `dispute_open → human_review` (SPEC §29 pause) ·
  `credit_covers_balance → do_nothing_yet` · `not_yet_due → do_nothing_yet` ·
  `promise_pending_future → do_nothing_yet` · `promise_failed →
  offer_payment_plan` · `aged_90_plus → human_review` ·
  `customer_unresponsive → human_review` · `large_stale_balance (31–90d ≥
  LARGE_EXPOSURE_MINOR=KES 50,000) → offer_payment_plan` ·
  `default_self_serve → send_payment_link`.

**Answer item shape everywhere:** `{ subject, capability, confidenceBasis?,
reasons[], evidenceIds[] }` — every claim resolves to a supplied input.

## Facts — the plain-data contract

The repo has no DB layer by design: callers project the owning lanes into
plain fact rows (`facts.ts`) and pass them in as arrays. Cross-lane references
are opaque `Uuid` ids; money is `bigint` minor units (numbers are refused —
floats are banned); dates are ISO-8601 strings.

| Fact | Projected from | Key fields |
|---|---|---|
| `CustomerFact` | behavior (F19) + adjustments (C4 credit) | `flags` (vocabulary), `creditBalanceMinor`+`creditCurrency` (both or neither) |
| `ReceivableFact` | receivables | `originalMinor`, `paidMinor` (R1: `paid ≤ original`), `state`, `dueDate` |
| `PaymentFact` | payments (confirmed family only — money that landed) | `amountMinor`, `receivedAt`, optional `allocatedMinor` (defaults to fully allocated; remainder = parked) |
| `PromiseFact` | promises | `status: pending\|fulfilled\|broken`, optional `promisedDate` |
| `DisputeFact` | disputes | `open: boolean` (live status projected) |

Optional `evidenceIds` on any fact let the adapter attach source event ids;
they flow through into the answers' evidence.

**Matching rules** (documented, deterministic):

- Facts stamped with a **different orgId than the query → REFUSED**
  (`AGENT_ORG_MISMATCH`) — an agent is never served a confident answer built
  from another org's data.
- Facts about a **different customer** than the `financialStateOf` subject →
  REFUSED (`AGENT_CUSTOMER_MISMATCH`) — a wrong-subject fact would silently
  zero the answer.
- Promise/dispute facts whose receivable was **not supplied** → IGNORED (they
  belong to another scope — `collections/derive.ts` precedent).
- **Empty inputs → REFUSED** (`AGENT_INPUT_EMPTY`); duplicate fact ids →
  REFUSED (`AGENT_*_DUPLICATE`); unknown flags/states/statuses/currencies →
  REFUSED with stable codes. Facts about the subject customer are optional.

**Behavior flag vocabulary** (`FLAG_WEIGHTS`, fixed and exported — unknown
flags are refused, never silently ignored): `slow_payer +6`,
`broken_promise +8`, `disputed_history +3`, `partial_payer +4`,
`unresponsive +5`, `reliable_payer −6`.

**Size bands** (`DEFAULT_SIZE_BANDS`, KES-calibrated, overridable per query
via `options.sizeBands`): balance `<1,000 → 0`, `<10,000 → 4`, `<100,000 → 8`,
`≥100,000 (minor units) → 12` points; bands must start at 0 and ascend.

## Events

`agent.queryServed` — the optional, narrow audit fact that a capability query
was served (`{ orgId, queryId, query, subjectId, answerCount, evidenceCount,
servedAt }`; ids + counts only, never amounts, never the answer body). The
queries stay pure; the adapter emits when its audit policy wants it. Envelope
mirrors the promises/disputes lanes: `{ name, version: 1, aggregateId,
occurredAt, payload }`, `aggregateId` = the query id.

## Rules

- Import ONLY from `../shared`. No other lane is imported — ever. (F22
  consumes these contracts by shape, not by import.)
- Pure functions: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`, and every query takes **exactly one** validated clock
  read (`assertAgentClock` returns the instant), so `asOf`, ages,
  `occurredAt` and payload timestamps on one answer can never disagree.
  Outputs are fresh objects, inputs are never mutated.
- Deterministic: identical inputs → identical answers (ordering is specified,
  not incidental).
- Stable `DomainError` codes (`AGENT_*` prefix, SCREAMING_SNAKE):
  `AGENT_ALLOCATION_INVALID`, `AGENT_AMOUNT_INVALID`, `AGENT_BALANCE_INVALID`,
  `AGENT_CLOCK_INVALID`, `AGENT_COUNT_INVALID`, `AGENT_CREDIT_FACT_INVALID`,
  `AGENT_CURRENCY_MISMATCH`, `AGENT_CURRENCY_UNSUPPORTED`,
  `AGENT_CUSTOMER_DUPLICATE`, `AGENT_CUSTOMER_MISMATCH`, `AGENT_DATE_INVALID`,
  `AGENT_DISPUTE_DUPLICATE`, `AGENT_DISPUTE_FACT_INVALID`,
  `AGENT_FLAG_UNKNOWN`, `AGENT_ID_MALFORMED`, `AGENT_INPUT_EMPTY`,
  `AGENT_ORG_MISMATCH` (`AGENT_ORG_REQUIRED` surfaces via `AGENT_ID_MALFORMED`
  on `orgId`), `AGENT_PAYMENT_DUPLICATE`, `AGENT_PROMISE_DUPLICATE`,
  `AGENT_PROMISE_STATUS_INVALID`, `AGENT_QUERY_KIND_INVALID`,
  `AGENT_RECEIVABLE_DUPLICATE`, `AGENT_RECEIVABLE_STATE_INVALID`,
  `AGENT_SIZE_BANDS_INVALID`, `AGENT_THRESHOLD_INVALID`.

## Definition of done

- Capability query suites over synthetic fact histories: exposure math incl.
  multi-currency, disputed/promise split, aging boundaries, scoring components
  in isolation + tie-breaks, evidence refs resolving to supplied inputs,
  recommendation matrix, refusal tables (empty/unknown-org/malformed),
  deterministic ordering, no-mutation pins, envelope shape.
- `npm run typecheck && npm test` green.

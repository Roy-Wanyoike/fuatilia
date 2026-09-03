# Memory lane — wave 5 (issue #37, VISION §3.3/§3.7)

The **customer financial memory**: `Financial Events → Normalized Facts →
Behavioral Features → Explainable Claims`. Fuatilia's answer to "why did
Fuatilia prioritize this customer?" is never an opaque score — every number is
a **claim with evidence**:

```ts
{ claim: 'payment.cadence', value: {…}, computedFrom: [eventId…], asOf: '…' }
```

`computedFrom` lists the exact evidence anchors (the caller's event ids) the
value was derived from; a reviewer — human or AI agent — can pull those events
and re-derive the number. Given the same facts and `asOf`, output is
byte-for-byte deterministic.

## Scope

- **Fact vocabulary** (`facts.ts`) — the plain-data input shape. The caller
  (adapter/projection job) reduces raw lane events into these facts; this lane
  imports no other lane. Ten fact types (v1), each `{ eventId, type, at,
  customerId, …payload }`: `invoice_issued`, `payment_received`,
  `allocation_applied`, `receivable_opened`, `receivable_settled`,
  `promise_outcome` (kept | broken | expired), `message_exchanged`
  (inbound | outbound), `consent_changed` (granted | revoked),
  `dispute_opened`, `dispute_resolved`. `eventId` is the evidence anchor and
  must be a UUID-shaped opaque id, unique across the history
  (`MEM_FACT_DUPLICATE_EVENT_ID`); channel names are the one free-form field.
- **Claims** (`claims.ts`) — one per behavioral dimension, in fixed order:
  | Claim name | Value | Emitted when |
  |---|---|---|
  | `payment.cadence` | days-to-pay distribution: `{ sampleCount, minDaysToPay, medianDaysToPay, p90DaysToPay }` (whole UTC days, clamped ≥ 0; median = averaged middle pair; p90 = nearest-rank ⌈0.9·n⌉) | ≥ 1 payment linked to an issued invoice |
  | `payment.sizeBands` | per currency `{ count, minMinor, p25Minor, medianMinor, p75Minor, maxMinor }` (nearest-rank quartiles) | ≥ 1 payment |
  | `promise.reliability` | `{ kept, broken, expired, total, rate }` (rate = kept/total) | ≥ 1 promise outcome |
  | `channel.preference` | inbound/outbound histogram per channel + consent status per channel (`granted`/`revoked`/`none` — the LATEST consent fact ≤ asOf by `at` wins, array order breaks exact-timestamp ties) | ≥ 1 message or consent fact |
  | `exposure.current` | per currency `{ openReceivables, openMinor, aging[4 buckets] }` — balance = opened − allocations (clamped ≥ 0), settled facts are authoritative; aging from due date vs asOf (day 30 → '0-30', 31 → '31-60', 61 → '61-90', 91 → '90+') | ≥ 1 receivable opened ≤ asOf |
  | `dispute.history` | `{ opened, resolved, currentlyOpen }` | ≥ 1 dispute fact |
- **Snapshot** (`snapshot.ts`) — `memorySnapshot(facts, asOf)` →
  `{ asOf, customers: CustomerMemory[] }` (sorted by customerId; each customer
  carries `claims` + `factCount`). Facts after `asOf` are invisible;
  `at === asOf` is included. Empty history ⇒ empty customers; a customer with
  facts but no derivable dimension ⇒ empty claims — silence is honest, never
  zeros pretending to be observations.
- **Rules for duplicate anchors** (a re-issued invoice, a double settlement, a
  consent flip): the fact's `at` decides, never array order — earliest issue /
  earliest settlement wins, latest consent wins, array order only breaks
  exact-timestamp ties. Claims must reflect history, not presentation.
- **Diff** (`diff.ts`) — `diffProfiles(before, after, clock, thresholds?)`
  classifies `payment_cadence` (median days-to-pay, lower is better),
  `promise_reliability` (kept rate, higher is better), `exposure` (per-currency
  open balance, higher is worse) and `disputes` (currently open, higher is
  worse) as `improving | stable | deteriorating`. `|Δ| ≥ threshold` crosses
  (the delta is rounded to 12 decimals first, so IEEE-754 noise can never flip
  an at-threshold classification).
  Defaults (`DEFAULT_DIFF_THRESHOLDS`): cadence 3 days, reliability 0.1,
  exposure 500 000 minor, disputes 1. Cadence/reliability with a missing claim
  on either side are **not comparable** (stable, nulls) — an unknown history is
  not a clean baseline; exposure/disputes treat missing as 0. Stable rows are
  listed in `changes` but stay **silent** (no event); only crossings emit
  `memory.behaviorChanged`.
- **Events** (`events.ts`) — repo envelope `{ name, version: 1, aggregateId,
  occurredAt, payload }`, occurredAt from ONE validated `clock.now()` read
  (`readClock` — the house one-clock-read-per-event rule):
  - `memory.snapshotTaken` — `{ customerId, asOf, claimCount, claims, factCount }`;
  - `memory.behaviorChanged` — `{ customerId, asOf, changes[], evidenceRefs }`
    where each change carries dimension/direction/before/after/threshold/reason
    (the VISION's `customer.behavior.changed` fact, §3.10).

## Rules

- Import ONLY from `../shared` (+ own files). Customers, invoices, payments,
  receivables, promises, disputes, channels' consent are referenced by opaque
  ids; the lane never dereferences them.
- Pure functions: no I/O, no RNG, no `Date.now()` — time enters via the ISO
  strings on facts, the caller's `asOf`, and the injected `Clock` for events.
  Inputs are never mutated; claims/snapshots are fresh plain objects.
- Money is minor-unit safe integers (bigint only for internal sums, guarded by
  `MEM_AMOUNT_OVERFLOW`); claim values stay JSON-serializable.
- Stable `DomainError` codes (SCREAMING_SNAKE, `MEM_*` prefix):
  `MEM_FACT_REQUIRED`, `MEM_FACT_UNKNOWN_TYPE`, `MEM_FACT_INVALID`,
  `MEM_FACT_DUPLICATE_EVENT_ID`, `MEM_CURRENCY_INVALID`, `MEM_ASOF_INVALID`,
  `MEM_SAMPLE_EMPTY`, `MEM_AMOUNT_OVERFLOW`, `MEM_CLOCK_INVALID`,
  `MEM_SNAPSHOT_INVALID`, `MEM_CUSTOMER_MISMATCH`, `MEM_THRESHOLD_INVALID`.
- **Supplier contract for F21 (financial-state) and F22 (NBA features):**
  consume `memorySnapshot` + `MEMORY_CLAIMS` + `Claim` as plain data — ids
  opaque, shapes stable at v1; the lanes must not need to import each other.
  Channel preference is deliberately NOT direction-classified in the diff
  (a preference change is not better/worse); it is visible in the claims.

## Definition of done

- Table-driven tests: cadence (min/median/p90 incl. even-sample median, single
  sample, nearest-rank edges), reliability, channel histogram + consent
  last-fact-wins, multi-currency size bands, exposure + allocation/settlement +
  aging boundaries (30/31/60/61/90/91), dispute counts, determinism pins,
  evidence-refs-resolve pins, empty-history, no-mutation, fact validation,
  diff threshold tables (crossing vs not-crossing per dimension), event
  envelope shape.
- `npm run typecheck && npm test` green.

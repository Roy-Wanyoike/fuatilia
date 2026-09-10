# internal/analytics — the ClickHouse analytics ingester (issue #89, ADR-0002)

The read-model side of the event fabric (FUATILIA_EVENTS, ADR-0003): this
package consumes relay envelopes and maintains the four dashboard projections
— `dso_daily`, `aging_migration`, `collector_effectiveness`, `cohort_recovery`
— plus the `event_fact` ledger that makes every figure provably
derived-from-events. DDL: `db/clickhouse/*.sql` (read that README first — it
owns meaning, labeling, NULL-with-reason and the rebuild path).

**Strictly read-model (ADR-0002):** PostgreSQL is the only financial source of
truth. This package never writes PostgreSQL, never owns a balance, and is the
only writer of the ClickHouse tables. Nothing in this store can move money.

## Architecture — two injected ports, zero connections

```
Consumer (port)          Ingester                        Driver (port)
JetStream durable   →    parse → dedupe → ledger append  →  Exec (INSERTs)
(later wave)             → per-org fold → emit rows      →  Query (replay ONLY)
```

| Port | Production face (later wave) | Test face |
|---|---|---|
| `Consumer` | a NATS JetStream durable, filtered consumer over `FUATILIA_EVENTS` with explicit ack | `stubConsumer` / `loopConsumer` (fake_test.go, ingester_test.go) |
| `Driver` | the real clickhouse-go driver | `fakeDriver` — an in-memory implementation of the SQL-string contract, golden-file snapshot-tested |

stdlib only; no clickhouse-go dependency, no DSN, no credentials cross either
port. Wiring the real faces is deliberately a later wave: this lane touches
neither `cmd/` nor `internal/outbox`.

## The SQL-string contract (sql.go)

Every statement the ingester can issue is a named constant in `sql.go`:
five `INSERT`s (parameterized `?` placeholders, clickhouse-go style) and one
`SELECT` (`LedgerSelectSQL`, the rebuild replay — the only Query). Values
only ever travel as parameters; no payload byte is ever concatenated into a
statement (guarded by `TestSQLContractStatementsAreParameterized`).

Two tests keep the contract honest without a server:

- `ddl_parity_test.go` parses `db/clickhouse/*.sql` and fails on any drift
  vs the contract: column names and order, placeholder counts, engine,
  ORDER BY keys, label defaults, plus a zero-secrets scan of both sides.
- `golden_test.go` snapshots the exact `(statement, args)` log of the
  canonical scenario into `testdata/golden/canonical_stream.golden` — SQL
  changes are reviewed diffs. Regenerate with:
  `go test ./internal/analytics -run TestSQLGoldenFiles -update`.

## Guarantees (each with its proof test)

| Guarantee | Mechanism | Proof |
|---|---|---|
| Idempotent by eventId, forever | dedupe on `(orgId, eventId)` across batches AND within one batch (overlapping delivery); ledger rows collapse under `ReplacingMergeTree(org_id, event_id)` | `TestIdempotencyRedeliveryCollapses`, `TestIdempotencyWithinBatchDuplicate` |
| Deterministic replays | the fold is a pure function of the per-org log in canonical `(created_at, eventId)` order; `computed_at` is that fold's watermark (the last canonical event's `created_at`), never the wall clock | `TestDeterministicReplayAnyBatchingAnyOrder` (whole-batch vs reversed + split + redelivered — final state byte-identical; fresh replays produce byte-identical statement logs), `TestSQLGoldenFilesDeterministic` |
| Out-of-order tolerated | delivery order is irrelevant: events insert into the org's canonical log (sorted `(created_at, eventId)`, mirroring `Outbox.drain()`'s `(created_at, id)`) and the org re-folds from scratch | `TestOutOfOrderDeliveryTolerated`, `TestCanonicalOrderMirrorsOutboxDrain` |
| Rebuild path (ADR-0002) | projections are disposable; `RebuildFromLedger` replays `LedgerSelectSQL` (the only read) and re-derives every row byte-identically, appending nothing | `TestRebuildFromLedgerByteIdentical` |
| Formula parity with `src/domain/projections/` | aging = the port of `aging.ts` (flooring, ±1-day boundaries, zero-balance skip-and-count, input-order evidence); effectiveness = the port of `effectiveness.ts` (ratios as-is, no clamp, NULL-with-reason, numerator-first deduped evidence) | `aging_test.go`, `effectiveness_test.go` — fixtures cite the TS spec rows they mirror |
| NULL-with-reason | `dso` / `collected_vs_billed` / `recovery_rate` bind NULL exactly when not honestly computable; `promise_kept` and `dispute_rate` are structurally NULL in v1 (no promise-made/kept event, no dispute event) with prose reasons as data | `TestCollectedVsBilledNullWithReason`, `TestStructuralV1NullsAreHonest`, `TestVoidedInvoiceNeverInflatesWindows` |
| Version pinning | handled events are pinned to payload v1; a v2 is refused (`EVENT_VERSION_UNSUPPORTED`) until handled explicitly. Unhandled events — and any future one, the envelope is additive — are ledger-only, preserved verbatim | `TestHandledEventsVersionPinned` |
| Verbatim payloads | the ledger stores the producer's jsonb byte-for-byte (the relay's fidelity rule, continued) | `TestLedgerPayloadVerbatim` |
| Per-org isolation | every figure is org-scoped; the same eventId from two orgs is two events | `TestPerOrgIsolation` |
| Counted skips, not crashes | a settlement for a receivable whose open event never arrived (and re-issued duplicate billing, R9 first-write-wins) is a counted, logged skip — visible, deterministic, never a silent figure change | `TestUnknownReceivableIsCountedSkip`, `TestDuplicateBillingFirstWriteWins` |

## The fold — what each event does

Canonical order `(created_at, eventId)` per org. Balance truth (mirroring
docs/04 and the receivables lane): `receivable.opened` (E05) opens at
`originalMinor`; `receivable.partiallySettled` (E06) makes `remainingMinor`
authoritative; `receivable.settled` (E07) and `receivable.writtenOff` (E09)
close the balance to 0 (E07 collects the balance at settle time);
`receivable.recovered` (E10) is a collection fact, never a resurrection.

| Event | Projection effect | Also |
|---|---|---|
| `invoicing.invoiceIssued` (E02) | billed (per currency, day-keyed) | void-corrected on E04, even when the void canonically precedes the issue |
| `invoicing.invoiceVoided` (E04) | removes the invoice's billed amount from its day | voided invoices' receivables leave AR/aging/cohort denominators |
| `receivable.opened` (E05) | book entry + cohort membership (month of open) | currency resolved from the billing invoice |
| `receivable.partiallySettled` (E06) | balance := remainingMinor; collected += amountMinor | |
| `receivable.settled` (E07) | balance := 0; collected += balance at settle time | |
| `receivable.overdue` (E08) | none — aging derives from E05 dueDate via the aging.ts port | ledger-only (E08 is the collections trigger, not aging truth) |
| `receivable.writtenOff` (E09) | balance := 0, terminal | |
| `receivable.recovered` (E10) | collected += amountMinor (balance stays 0) | |
| `collections.promiseBroken` (E27) | `promises_broken` evidence count; the day closes an effectiveness window | never opens a dso/aging row (the book did not move) |
| everything else | none | ledger-only, verbatim; `allocation.executed` (E24) / `adjustment.creditNoteApplied` (E20) money is NOT folded — the receivable side already arrives as E06/E07/E10, folding it too would double-count |

Emission is full-state per batch: every key that exists in state is
re-derived and re-upserted with the current watermark, so batching order can
never leave a stale figure (`ReplacingMergeTree(computed_at)` collapses
intermediate versions; audited reads use `FINAL`). Each table closes on the
days its own inputs moved: `dso_daily`/`aging_migration` on book/billing
days, `collector_effectiveness` on book/billing days plus promise-outcome
days.

## Wiring the real faces (later wave — intentionally not in this lane)

```go
// sketch — the NATS JetStream consumer face of the Consumer port
nc, _ := nats.Connect(natsURL)                       // deployment config, never in code
js, _ := nc.JetStream()
sub, _ := js.PullSubscribe("", "analytics-projections",
        nats.BindStream("FUATILIA_EVENTS"),
        nats.Bind("FUATILIA_EVENTS", "analytics-projections")) // filtered durable
for {                                                 // mirrors Ingester.Run's cadence
        msgs, err := sub.Fetch(batchSize, nats.MaxWait(pollInterval))
        // 1. Collect the raw envelope bytes → ing.IngestBatch(ctx, batch)
        // 2. On success: msg.Ack() for every message in the batch.
        //    On failure: Nak() / Terminate() per the DLQ policy — at-least-once
        //    redelivery is safe: the ingester dedupes (orgId, eventId) forever.
        // 3. Idle → poll again (PollInterval).
}
```

Driver face: implement `Driver` over clickhouse-go (`Exec` for the five
INSERTs, `Query` refusing everything but `LedgerSelectSQL`), then run
`RebuildFromLedger` once at commissioning to backfill from the ledger.
`IngestBatch` returns per-cycle `Stats` (received/accepted/duplicates/
ledger appends/rows emitted/skips) — export those as metrics when wiring.

Ops notes:

- One ingester per process, like the outbox relay (single-goroutine fold
  state; scale by org-partitioning consumers, not by sharing state).
- A `Consume` error is terminal for `Run` — the wiring owns retry/backoff.
  A batch error is also returned (fail loud): the batch was NOT marked seen,
  so redelivery replays it harmlessly.
- The fold's counted skips (`Stats.Skipped`, `analytics.fold_skip` warnings)
  are data-gap signals, not errors — investigate, don't alert-page on them.

## Testing

```
cd backend-go
go test ./internal/analytics -count=1          # the whole lane, no services needed
go test ./internal/analytics -run TestSQLGoldenFiles -update   # regenerate the golden file
```

No ClickHouse server (or any container) is required: the fake driver IS the
SQL contract's executable face, and DDL parity is enforced by parsing the
actual `db/clickhouse/*.sql`. The honest limitation — this DDL has never run
against a real cluster — is documented in `db/clickhouse/README.md`.

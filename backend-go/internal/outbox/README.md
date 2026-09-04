# internal/outbox — the transactional-outbox relay (ADR-0003, issue #74)

The production face of the event fabric: `cmd/worker` drains the
`outbox_events` table (the PostgreSQL face of `src/domain/events/outbox.ts`,
schema in `db/migrations/0013_audit_outbox.sql`) and publishes every envelope
to NATS JetStream **at-least-once, in per-org append order**, without ever
mutating financial state.

```
domain tx: state + outbox row (one PostgreSQL transaction)
        ↓
relay (cmd/worker): SELECT … FOR UPDATE SKIP LOCKED per org
        ↓ publish → JetStream ack
        ↓ mark published (same transaction)
FUATILIA_EVENTS  (subjects fuatilia.>)
        ↓
consumers — idempotent by eventId, forever
```

## Subject grammar

    fuatilia.<domain>.<event>.v<version>

derived from the row's `(event_type, version)` — e.g. `payment.confirmed`
v1 publishes on `fuatilia.payment.confirmed.v1`; a future breaking payload
change ships v2 on `.v2`, so consumers can pin a version and never observe
an unannounced shape change. `event_type` must match the TS catalog naming
convention (`<context>.<aggregate><PastTenseVerb>`, lowerCamelCase, exactly
one dot — `src/domain/events/envelope.ts` `EVENT_NAME_PATTERN`). The relay
is the LAST enforcement point: a grammar-invalid row is **poisoned, never
published**. All 27 catalog names (`src/domain/events/catalog.ts` E01–E27)
are pinned byte-for-byte in `subjects_test.go`, so a naming drift fails this
lane's gate before it can reach the broker.

## Delivery guarantees

| Guarantee | Mechanism | Proof |
|---|---|---|
| At-least-once | publish-then-mark per row inside one org-batch transaction; crash between publish and mark rolls the batch back to pending | `TestCrashBetweenPublishAndMarkRedeliversUnmarkedSet` (fault-injection hook `afterPublish`) |
| No consumer-visible duplicates inside the window | JetStream server-side dedup, `Nats-Msg-Id = "<org_id>:<event_id>"`, window 2 min (`DefaultDuplicateWindow`) | same test asserts stream still carries exactly N msgs after redelivery |
| Per-org order | `(created_at, id)` batch order; a failed publish stops the org's batch so no successor overtakes it; poisoned rows are terminal and cannot reorder | `TestRelayPreservesPerOrgOrderAcrossEvents`, `TestRelayBatchLimitLeavesRemainderPending` |
| No double publish across relays | `pg_try_advisory_xact_lock(hashtextextended(org,0))` per-org lock + `FOR UPDATE SKIP LOCKED` rows; losers skip, never block | `TestTwoConcurrentRelaysNeverDoublePublish` |
| Envelope fidelity | payload bytes published **verbatim** — the jsonb column's canonical text is appended byte-for-byte (`buildEnvelope`), never re-marshalled; money never reinterpreted | `TestRelayPublishesAppendedEventsAndMarksPublished` (asserted against the DB-read payload) |
| Poison safety | grammar-invalid → poisoned immediately (attempts untouched); publish failure after `OUTBOX_MAX_ATTEMPTS` → poisoned with `last_error` recorded; both leave the pending stream | `TestPoisonGrammarInvalidRowTerminalSuccessorsProceed`, `TestPoisonAttemptsExhaustedCommittedPerCycle` |
| Replay is idempotent | replay flips status back to pending (no new rows); republish uses the SAME `(org_id, event_id)`; consumer dedup unchanged | `TestReplayPoisonsRequeuesAndRepublishes` |

Consumers MUST be idempotent by `eventId` forever — duplicates are bounded
by the batch window after a crash, not eliminated. This is the same
at-least-once contract the Daraja intake assumes (invariant R9).

## Stream design (ADR-0003 decision record)

**Single stream `FUATILIA_EVENTS`, subjects `fuatilia.>`, limits retention,
file storage, `Nats-Msg-Id` dedup window 2 min.**

Why not a WorkQueue stream per subject: work-queue retention removes a
message as soon as ANY consumer acks, which silently drops the replay path
(projection rebuilds need every message re-readable) and multiplies stream
administration by the catalog size. Limits retention keeps the fabric
replayable (`worker replay --from --to` re-feeds a time range) at the cost
of an explicit retention limit per deployment — set `--max-age`/`--max-bytes`
when commissioning production. Per-subject filtered durable consumers give
the same isolation a per-subject queue would, without the semantics loss.
`EnsureStream` only guarantees the minimum (subjects + dedup) and never
fights an operator's tuned configuration.

## Configuration (env — mapped in `cmd/worker/main.go`)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL DSN (least-privilege role below) |
| `NATS_URL` | — (required) | NATS server URL |
| `OUTBOX_BATCH` | 100 | max pending rows one org contributes per cycle (worst-case duplicate window) |
| `OUTBOX_POLL_INTERVAL` | 1s | idle wait between cycles |
| `OUTBOX_MAX_ATTEMPTS` | 5 | publish-attempt budget before poisoning |

Graceful shutdown: SIGTERM drains the in-flight org batch (its marks commit),
cancellation is only observed between org batches — a stopped worker never
strands half a batch.

## DLQ runbook

1. **Inspect** — poisoned rows are the DLQ:
   `SELECT org_id, event_id, event_type, attempts, last_error, created_at
    FROM outbox_events WHERE status = 'poisoned' ORDER BY created_at;`
2. **Classify** — `reason = subject_grammar` (see `last_error`) means the
   producer wrote a non-catalog name: fix the producer, the row itself is
   only republishable if the `event_type` column is corrected by its owner.
   `attempts_exhausted` means the broker was down/failing: fix the cause.
3. **Replay** — `worker replay poisons` requeues the whole DLQ (fresh attempt
   budget, attempts = 0, `last_error`/`published_at` cleared);
   `worker replay --from RFC3339 --to RFC3339` re-feeds a `created_at`
   window regardless of status (projection rebuilds). Replaying into a
   still-broken pipeline is safe but wasteful — rows simply re-poison.

## Consumer idempotency contract

Envelope (published bytes):

```json
{"eventId":"<uuid>","name":"<catalog name>","version":1,
 "orgId":"<uuid>","createdAt":"<RFC3339Nano>","payload":<verbatim jsonb>}
```

- Deduplicate on `eventId` **per `orgId`** (the stream dedup key is
  `<org_id>:<event_id>`; the same uuid from a different org is a different
  event).
- `version` is part of the subject — pin it and handle new versions
  explicitly; never assume the payload shape changes transparently.
- `payload` is the producer's jsonb — parse it, never reconstruct it.

## Integration tests

The suite runs against **real PostgreSQL 16.4 + real JetStream** (embedded
`nats-server`, same binary as production topologies — no stub publisher
exists in this lane). Default DSN
`postgres://postgres@127.0.0.1:5435/fuatilia_test`, override with
`FUATILIA_TEST_DATABASE_URL`. Boot the per-lane cluster:

```sh
PGDIR=/home/z/my-project/tools/postgresql-16.4.0-x86_64-unknown-linux-gnu/bin
$PGDIR/initdb -D /home/z/my-project/tools/pgdata-10-c -U postgres -A trust
$PGDIR/pg_ctl -D /home/z/my-project/tools/pgdata-10-c \
        -o "-p 5435 -k /home/z/my-project/tools" -l pgdata-10-c.log start
createdb -h 127.0.0.1 -p 5435 -U postgres fuatilia_test
node -e '…apply db/migrations/*.sql in order…'   # see db/README.md
go test ./internal/outbox/ -race
```

Unreachable PG fails the run (it is part of the merge gate); it never
silently skips.

## Least-privilege deployment role

```sql
CREATE ROLE outbox_relay LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO outbox_relay;
GRANT SELECT, UPDATE ON outbox_events TO outbox_relay;  -- status/attempts bookkeeping only
```

The relay's entire database footprint is `SELECT` plus status bookkeeping on
`outbox_events` — it cannot touch financial tables even if compromised.
NATS credentials come from env only; payload bytes never reach the logs
(structured records carry `event_id`/`event_type`/counts — proven in
`TestRelayRunOnceLogsCycleWithLag`).

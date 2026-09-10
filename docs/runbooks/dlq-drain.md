# Runbook — DLQ drain: safe requeue + poison criteria

Scope: the dead-letter queue. **There is no separate DLQ table** — poisoned
rows of `outbox_events` ARE the DLQ
([db/migrations/0013_audit_outbox.sql](../../db/migrations/0013_audit_outbox.sql):
`status CHECK (status IN ('pending','published','poisoned'))`). Poison
semantics live in `backend-go/internal/outbox/poison.go`; the requeue
operations live in `backend-go/internal/outbox/replay.go` behind the
`worker replay` CLI (`backend-go/cmd/worker/main.go`). The in-tree mini
runbook: `backend-go/internal/outbox/README.md § DLQ runbook`.
Entry point: [on-call-triage.md](on-call-triage.md).

> **Validated.** SQL executed against PostgreSQL 16.4 (migrations 0001–0015,
> seeded poisoned rows of both classes). CLI verified end-to-end: built
> `cmd/worker`, ran `replay poisons` (→ `requeued N poisoned event(s)`, exit 0,
> poisoned rows flipped to `pending` with `attempts=0`, `last_error` cleared),
> `replay --from/--to` with a non-advancing window (→ `OUTBOX_REPLAY_RANGE_INVALID`,
> exit 1) and a malformed invocation (→ usage text, exit 2).

## Poison criteria (when a row lands in the DLQ)

Two, and only two, entry paths (`poison.go`):

| Class | Trigger | Committed evidence |
|---|---|---|
| `subject_grammar` | The row's `(event_type, version)` cannot produce a grammar-valid subject (`subjects.go`; relay is the LAST enforcement point). Terminal, **zero publish attempts** — `poisonInvalid` leaves `attempts` untouched. | `status='poisoned'`, `attempts=0`, `last_error` carries the `EVENT_NAME_MALFORMED`/`EVENT_VERSION_UNSUPPORTED` refusal; log record `outbox.poisoned` with `reason="subject_grammar"` |
| `attempts_exhausted` | Publishing failed `OUTBOX_MAX_ATTEMPTS` times (default 5, `docker-compose.yml`). Every failed attempt is committed individually (`attempts +1`, `last_error` recorded) so you can see how hard the broker was tried. | `status='poisoned'`, `attempts >= 5`, `last_error` carries the broker error; log record `outbox.poisoned` with `reason="attempts_exhausted"` |

The classifier key is exact: **`attempts = 0` ⇔ grammar poison; `attempts ≥ 1`
⇔ budget exhaustion.** (`markFailed` only poisons at `attempts >= MaxAttempts`,
and `MaxAttempts ≥ 1` is enforced by config validation.)

Poisoned rows leave the pending stream immediately, so they cannot reorder or
block their per-org successors — a full DLQ never slows live traffic.

## Symptoms

- `docker compose logs worker | grep 'outbox.poisoned'` records appear.
- `fuatilia_outbox_dlq_depth` / `fuatilia_outbox_dlq_in_total` rising **when
  the observability lane is wired** — it is not yet; see
  [observability.md](observability.md) for the wiring follow-up (issue #88
  landed the series; nothing mounts them). SQL is the interim dashboard.
- Downstream consumers report missing events (the event never reached
  JetStream).

## Diagnosis

```sql
-- D1. Inspect the DLQ (outbox README § DLQ runbook, verbatim)
SELECT org_id, event_id, event_type, attempts, last_error, created_at
FROM outbox_events WHERE status = 'poisoned' ORDER BY created_at;

-- D2. Classify without guessing (the attempts=0 rule above)
SELECT CASE WHEN attempts = 0 THEN 'subject_grammar' ELSE 'attempts_exhausted' END AS poison_class,
       event_type, count(*), min(created_at) AS first_poisoned, max(created_at) AS last_poisoned
FROM outbox_events WHERE status = 'poisoned' GROUP BY 1, 2 ORDER BY last_poisoned DESC;
```

```sh
# D3. The relay's own account of why (ids + reasons, never payload bytes)
docker compose logs --since=24h worker | grep 'outbox.poisoned'
```

Class-specific reading:

- **`subject_grammar`**: the PRODUCER wrote a non-catalog name. The catalog is
  `src/domain/events/catalog.ts` (E01–E27, pinned byte-for-byte in
  `subjects_test.go`); the grammar is `<context>.<aggregate><PastTenseVerb>`
  v-suffixed (`internal/outbox/subjects.go`). The row is only republishable if
  the `event_type` column is **corrected by its owner** (a deliberate data
  fix), e.g.:
  `UPDATE outbox_events SET event_type = 'payment.confirmed' WHERE id = '<uuid>';`
  — run by the owning team after fixing the producer binary that wrote the bad
  name. On-call never invents a mapping.
- **`attempts_exhausted`**: the broker was down/failing at the time. Confirm
  the cause is gone (NATS healthy, `docker compose ps nats`, no fresh
  `outbox.publish_failed` records) before requeueing.

## Safe requeue procedure (the drain)

1. **Fix the cause first.** Requeueing into a still-broken pipeline is safe
   but wasteful — grammar rows re-poison immediately, broker rows burn the
   fresh budget again (`replay.go` ReplayPoisons doc; `README.md § DLQ
   runbook` step 3).
2. **Snapshot the DLQ** (D1 output) into the incident record: orgs, event ids,
   classes, counts.
3. **Grammar rows:** if any, get the producer fix + owner-approved
   `event_type` correction done FIRST (or explicitly decide to exclude them —
   see "When NOT to requeue").
4. **Requeue the whole DLQ with the CLI:**

   ```sh
   docker compose exec worker /worker replay poisons    # usage: worker replay poisons
   # → "requeued N poisoned event(s)" (exit 0); stderr JSON: worker.replay_poisons
   ```

   What it does (`replay.go` `replayPoisonsSQL`, verbatim semantics — verified):
   `UPDATE outbox_events SET status='pending', attempts=0, last_error=NULL,
   published_at=NULL WHERE status='poisoned'`. No new rows are inserted; the
   relay republishes under the SAME `(org_id, event_id)`, so consumers and the
   JetStream `Nats-Msg-Id` dedup key stay idempotent.
5. **Watch it drain** ([outbox-lag.md](outbox-lag.md) Q1/Q5):

   ```sql
   SELECT count(*) FILTER (WHERE status='pending') AS pending,
          count(*) FILTER (WHERE status='published' AND published_at >= now() - interval '5 minutes') AS published_5m,
          count(*) FILTER (WHERE status='poisoned') AS poisoned_again
   FROM outbox_events;
   ```

   `poisoned_again > 0` → the "fix" wasn't a fix; back to Diagnosis. Do NOT
   loop requeues.
6. **Projections/receivers that need the full history re-fed** (not just DLQ
   rows) → range replay:

   ```sh
   docker compose exec worker /worker replay --from 2026-01-31T00:00:00Z --to 2026-01-31T01:00:00Z
   # [from, to) on created_at, regardless of status; refuses a non-advancing
   # window with OUTBOX_REPLAY_RANGE_INVALID (exit 1); bad syntax → usage, exit 2
   ```

## When NOT to requeue

- **Grammar rows whose producer is unfixed** — they will re-poison (with
  `attempts` again untouched, so the classifier stays truthful). Excluding
  them is legitimate: leave them poisoned and track the correction with the
  owning team.
- **Any impulse to DELETE poisoned rows.** Deletion is not a sanctioned
  operation anywhere in the outbox lane; the row is the audit evidence of a
  refused publish. If an event is genuinely void, the owning domain records a
  compensating event through its normal API path.
- Direct SQL requeue (`UPDATE … SET status='pending'`) — even though the
  statement is simple, the CLI is the contract (least-privilege relay role,
  logging, count reporting). Use the CLI.

## Escalation

- Grammar poisons → Go backend lane + the producing team; include D2 output.
  A NEW catalog name is a contract change (`src/domain/events/catalog.ts` +
  `subjects_test.go` pinning) — never a hotfix UPDATE alone.
- `attempts_exhausted` recurring without an obvious broker outage → Go backend
  lane (may be a broker resource limit — stream `--max-age`/`--max-bytes` are
  operator-tuned per `internal/outbox/README.md § Stream design`).
- DLQ > few hundred rows or any financial-critical event type
  (`payment.confirmed`) stuck > 1h → SEV2, orchestrator informed.

## References

- [backend-go/internal/outbox/poison.go](../../backend-go/internal/outbox/poison.go) — the two poison paths, verbatim
- [backend-go/internal/outbox/replay.go](../../backend-go/internal/outbox/replay.go) — ReplayPoisons / ReplayRange SQL
- [backend-go/cmd/worker/main.go](../../backend-go/cmd/worker/main.go) — `replay` CLI parsing, exit codes 0/1/2
- [backend-go/internal/outbox/subjects.go](../../backend-go/internal/outbox/subjects.go) — subject grammar (enforcement point)
- [src/domain/events/catalog.ts](../../src/domain/events/catalog.ts) — the event-name catalog the grammar enforces

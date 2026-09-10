# Runbook — Outbox lag: symptom → SQL → remediation

Scope: the transactional outbox (`outbox_events`) and the relay that drains it
(`backend-go/cmd/worker` → `backend-go/internal/outbox/`). Schema:
[db/migrations/0013_audit_outbox.sql](../../db/migrations/0013_audit_outbox.sql)
(`status CHECK (status IN ('pending','published','poisoned'))`, unique
`(org_id, event_id)`, partial index `idx_outbox_events_pending` on pending rows).
Entry point: [on-call-triage.md](on-call-triage.md).

> **Validated.** Every SQL statement below was executed against PostgreSQL
> 16.4 with migrations 0001–0015 applied (seeded fixtures; `psql 16.4`).
> Q1 is the relay's own probe (`backend-go/internal/outbox/relay.go`,
> `pendingLag`) verbatim.

## What the relay guarantees (context for interpreting lag)

Per-org append order, at-least-once, publish-then-mark in one transaction per
org batch (`backend-go/internal/outbox/relay.go`, README table of proofs).
Defaults: `OUTBOX_BATCH=100` rows/org/cycle, `OUTBOX_POLL_INTERVAL=1s`,
`OUTBOX_MAX_ATTEMPTS=5` (env contract in `docker-compose.yml` +
`backend-go/internal/outbox/README.md`). A failed publish **stops that org's
batch** — no successor overtakes it — so retries stall one org, never reorder
it.

## Symptoms

- Consumers (webhook delivery, downstream projections) go quiet while the API
  keeps writing — intake still succeeds (truth lands in PG first).
- `docker compose logs worker` shows `outbox.cycle` records with `lag_rows`
  climbing or `lag_oldest_ms` in minutes+ (`relay.go` RunOnce).
- When the observability lane is wired (see [observability.md](observability.md)):
  `fuatilia_outbox_lag_rows` and `fuatilia_outbox_lag_oldest_seconds` rising.
  **Unwired follow-up** — these gauges exist in
  `backend-go/internal/observability/metrics.go` but nothing mounts them yet;
  the SQL below is the interim dashboard (issue #88 landed the library; wiring
  tracked as the #144 follow-up ledger — file a dedicated issue before wiring).
- Worker crash-looping: `docker compose ps` shows `worker` restarting.

## Diagnosis

```sh
docker compose ps worker                 # is the relay up?
docker compose logs --since=15m worker | grep -E 'outbox\.(cycle|poisoned|publish_failed|failed)'
```

```sql
-- Q1. The relay's own lag probe (relay.go pendingLag, verbatim)
SELECT count(*), min(created_at) FROM outbox_events WHERE status = 'pending';

-- Q2. Same, in an operator-readable shape (age in seconds)
SELECT count(*) AS lag_rows,
       COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))::bigint, 0) AS oldest_pending_seconds
FROM outbox_events WHERE status = 'pending';

-- Q3. Per-org breakdown — one noisy tenant vs global stall
SELECT o.slug, count(*) AS pending, max(now() - b.created_at) AS oldest_age
FROM outbox_events b JOIN orgs o ON o.id = b.org_id
WHERE b.status = 'pending' GROUP BY o.slug ORDER BY oldest_age DESC;

-- Q4. Head-of-line rows: attempts + last_error say WHY they are pending
SELECT org_id, event_id, event_type, attempts, created_at, last_error
FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20;

-- Q5. Publish throughput over the last 15 minutes (is progress happening at all?)
SELECT count(*) AS published_15m FROM outbox_events
WHERE status = 'published' AND published_at >= now() - interval '15 minutes';

-- Q6. Is the DLQ also filling? (publish failures commit attempts; at 5 → poisoned)
SELECT count(*) AS poisoned FROM outbox_events WHERE status = 'poisoned';
```

Interpretation:

| Observation | Meaning |
|---|---|
| `worker` down, lag grows, attempts stay 0 | Relay is the problem → restart it; lag drains at ≥ `OUTBOX_BATCH` per org per cycle |
| Q4 rows with `attempts` 1–4 and `last_error` like `nats: connection refused` | Broker failing; each cycle burns one attempt; **sustained outage poisons rows after `OUTBOX_MAX_ATTEMPTS` (default 5) — with a 1s poll that is seconds, not minutes** → fix NATS first, then expect to drain the DLQ ([dlq-drain.md](dlq-drain.md)) |
| Q4 rows with `attempts = 0`… that vanish from pending | Normal churn OR immediately-poisoned grammar refusals (check `outbox.poisoned` logs / Q6) |
| One org deep, others fine | That org hit a failing publish (batch stop) or a bulk write burst; check its head-of-line row |
| Q5 = 0 over 15m with worker up and NATS healthy | PG-side stall (pool exhaustion, locks): check `fuatilia_pg_*` gauges when wired, and api logs |

## Remediation

1. **Relay down** → `docker compose restart worker` (restart policy is
   `unless-stopped`; if it crash-loops, read the logs — config errors exit
   non-zero at boot: `DATABASE_URL` required, durations must parse as Go
   durations, `cmd/worker/main.go` `loadConfig`).
2. **Broker down** → fix NATS first (`docker compose ps nats`, its
   `/healthz` healthcheck is internal-only; `docker compose restart nats`).
   The worker keeps retrying the broker forever
   (`nats.MaxReconnects(-1)`, `cmd/worker/main.go`) — it will resume on its
   own once the broker is healthy.
3. **Rows reached `poisoned`** (Q6 > 0) → the DLQ runbook:
   [dlq-drain.md](dlq-drain.md). Do not hand-UPDATE `outbox_events`.
4. **Consumers need a re-feed of history** (not a lag problem but a rebuild):
   `worker replay --from RFC3339 --to RFC3339` re-publishes a `created_at`
   window regardless of status — idempotent by `(org_id, event_id)`;
   see [dlq-drain.md](dlq-drain.md) § Range replay.
5. **Sustained organic growth** (lag climbs while everything is healthy):
   raise `OUTBOX_BATCH` (and/or lower `OUTBOX_POLL_INTERVAL`) in `.env` and
   `docker compose up -d --force-recreate worker`. These knobs bound the
   worst-case duplicate window after a crash (`relay.go` DefaultBatchSize
   comment) — do not inflate casually.

**Never** INSERT/UPDATE/DELETE `outbox_events` by hand: the only sanctioned
mutation path is the replay CLI (it flips `status` back to `pending`, resets
`attempts`, clears `last_error`/`published_at` — `backend-go/internal/outbox/replay.go`).

## Escalation

- Lag > 15 minutes or `dlq_depth` climbing during remediation → escalate to
  the Go backend lane (outbox owner) with Q2/Q3/Q4 outputs.
- Evidence of duplicate delivery downstream (consumer reports the same
  `eventId` twice outside the 2-minute JetStream dedup window) → SEV2,
  Go backend lane; capture consumer-observed `eventId` + `orgId` pairs —
  the dedup key is `<org_id>:<event_id>` (`relay.go` DefaultDuplicateWindow).
- Suspected PG-side stall (Q5 stuck, no errors anywhere) → orchestrator;
  include `docker compose logs --since=30m worker api`.

## References

- [backend-go/internal/outbox/relay.go](../../backend-go/internal/outbox/relay.go) — pendingLag probe, per-org order, poison budget
- [backend-go/internal/outbox/README.md](../../backend-go/internal/outbox/README.md) — delivery-guarantee proofs, config table, DLQ runbook
- [db/migrations/0013_audit_outbox.sql](../../db/migrations/0013_audit_outbox.sql) — `outbox_events` DDL + status CHECK
- [cmd/worker/main.go](../../backend-go/cmd/worker/main.go) — env mapping, exit codes, graceful shutdown
- [observability.md](observability.md) — `fuatilia_outbox_*` series (wiring status)

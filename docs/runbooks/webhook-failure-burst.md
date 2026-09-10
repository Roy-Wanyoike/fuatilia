# Runbook — Webhook failure burst

Scope: outbound webhook deliveries (`webhook_deliveries` / `webhook_endpoints`,
[db/migrations/0012_webhooks.sql](../../db/migrations/0012_webhooks.sql)) and
the bounded retry ladder that executes them
(`backend-go/internal/webhooks/attempts.go`, executed by
`backend-go/internal/webhooks/worker.go` + `store.go`). Entry point:
[on-call-triage.md](on-call-triage.md).

> **Validated.** Every SQL statement below was executed against PostgreSQL
> 16.4 with migrations 0001–0015 applied (seeded deliveries in every state).

## The ladder (memorize these numbers)

`backend-go/internal/webhooks/attempts.go` — `DefaultRetryLadder` (ported 1:1
from the TS spec `src/domain/webhooks/attempts.ts`, SPEC §53):

```
attempt N fails → retry after ladder[N-1]:
  30s, 2m, 10m, 30m, 2h, 6h          (6 steps, strictly ascending)
```

- Total attempts = `len(ladder) + 1` = **7**; the 7th failure dead-letters
  (`WillRetry(attemptNo) = attemptNo <= len(ladder)`; `MaxAttemptsFor`).
- Worst-case span from first failure to terminal: 30s+2m+10m+30m+2h+6h =
  **~8h42m**.
- Every attempt appends to an immutable attempt log; failures live in the log,
  never in a phantom status. A failed attempt with retries left returns the
  delivery to `queued` (the DB enum spells the retry-pending state `failed`;
  `store.go` maps the two) with a deterministic `next_attempt_at`.
- Failure reasons are mandatory (`WEBHOOK_FAILURE_REASON_REQUIRED`) — a
  dead-lettered row always says why in `last_error`.
- Claim lease: `delivering` rows are recoverable after
  `DefaultClaimLease = 2m` (`worker.go`); delivery timeout 15s per POST.
  Crash between POST and record ⇒ lease expires ⇒ next claim re-POSTs —
  **at-least-once; receivers dedupe by event id** (worker.go constraint map).

**Wiring status (honest):** the delivery worker is a library — no `cmd/*`
binary mounts `internal/webhooks` yet, and `/v1` has no endpoint-management
operations (grep-verified on main @ 5280e0a). Delivery enqueue currently
happens on the API lane; the claim/execute loop needs a wiring follow-up
(tracked in the #144 follow-up ledger — file a dedicated issue before
wiring; library + proofs: PR #91 / issue #91 closed). SQL below is therefore
the primary diagnosis surface today.

## Symptoms

- A receiver's endpoint has an incident → its deliveries walk the ladder →
  after ~8h42m the events arrive as `dead_lettered` rows the receiver never
  saw.
- Burst: one receiver's 5xx/timeout storm fans out across ALL its due
  deliveries; retry waves re-fire every 30s, then 2m, … (the ladder looks like
  an attack on your own logs).
- `dead_lettered_at` spikes in the last hours = receiver-side incident that
  ended silently.

## Diagnosis

```sql
-- W1. Queue depth due right now (the claim predicate's shape — store.go claimDueSQL)
SELECT count(*) AS due_now FROM webhook_deliveries
WHERE state IN ('queued','failed') AND COALESCE(next_attempt_at, created_at) <= now();

-- W2. Stuck in flight: 'delivering' beyond the 2m claim lease
--     (recovered automatically on the next claim — look for a PATTERN of these)
SELECT id, org_id, endpoint_id, event_id, attempt_count,
       now() - updated_at AS lease_age
FROM webhook_deliveries
WHERE state = 'delivering' AND updated_at <= now() - interval '2 minutes';

-- W3. Burst view: retrying deliveries grouped by receiver URL, last 15 minutes
SELECT e.url, count(*) AS retrying, max(d.next_attempt_at) AS next_fire,
       max(d.last_error) AS sample_error
FROM webhook_deliveries d
JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id
WHERE d.state IN ('queued','failed') AND d.attempt_count > 0
  AND d.updated_at >= now() - interval '15 minutes'
GROUP BY e.url ORDER BY retrying DESC;

-- W4. Dead-letter tally by receiver
SELECT e.url, count(*) AS dead, max(d.dead_lettered_at) AS most_recent
FROM webhook_deliveries d
JOIN webhook_endpoints e ON e.org_id = d.org_id AND e.id = d.endpoint_id
WHERE d.state = 'dead_lettered' GROUP BY e.url ORDER BY dead DESC;

-- W5. Detail on the dead (last 50): reason lives in last_error
SELECT id, org_id, event_type, attempt_count, last_error, dead_lettered_at
FROM webhook_deliveries WHERE state = 'dead_lettered'
ORDER BY dead_lettered_at DESC LIMIT 50;
```

Reading the numbers: `attempt_count` on a `failed` row = attempts already
burned; the NEXT retry fires at `next_attempt_at = last failure +
ladder[attempt_count - 1]` (`attempts.go` BackoffFor). One URL dominating W3/W4
= receiver-side incident, not a Fuatilia fault.

## Remediation

1. **Fix the receiver.** The ladder is doing its job; almost every burst ends
   at the receiver's ops (their 5xx / TLS / DNS). W3's `sample_error`
   distinguishes transport failures (`dial tcp …: connection refused`,
   `delivery timed out`) from non-2xx responses.
2. **Stop hammering a dead receiver** (no `/v1` op exists yet — deliberate
   operator data fix, honored at the source because the claim query joins
   `webhook_endpoints ON e.active`, `store.go` `claimDueSQL`):

   ```sql
   UPDATE webhook_endpoints SET active = false
    WHERE org_id = '<org-uuid>' AND id = '<endpoint-uuid>';  -- rows wait, not fail
   ```

   Re-enable with `active = true` — queued/failed rows resume on their
   schedule. Nothing is lost by pausing.
3. **Lease-recovery loops** (W2 shows the SAME ids repeatedly): a delivery
   that consistently outlives claim+lease+timeout is timing out mid-POST
   (receiver accepts, never answers). Fix the receiver; no Fuatilia-side
   action is sanctioned — the recovery path itself is the at-least-once
   guarantee working as designed.
4. **Dead-lettered events** need re-driving: there is **no webhook DLQ drain
   CLI today** (the outbox `replay` covers `outbox_events` only). The
   sanctioned re-drive primitive is the outbox range replay
   ([dlq-drain.md](dlq-drain.md) § Safe requeue, step 6) — re-publishing the
   event lets the enqueue path re-create the delivery; re-enqueue is
   idempotent per `(org_id, endpoint_id, event_id)`
   (`uq_webhook_deliveries_endpoint_event`, 0012), so a duplicate delivery row
   cannot be created. If a receiver needs ONLY the dead-lettered subset, have
   it pull the signed payload from the `webhook_deliveries` row (W5) through
   an agreed channel — do not mutate `state` by hand.
5. **Secrets discipline:** endpoint signing secrets are stored HASHED (0012);
   nobody can re-sign a payload for manual delivery — never ask for or store
   plaintext secrets in tickets.

## Escalation

- Receiver outage > 2h with dead-letters accumulating → notify the receiver's
  contact + integrations lane; agree the re-drive plan (step 4) BEFORE running
  it, so the receiver is ready to dedupe.
- W2 patterns (chronic lease steals) → Go backend lane (worker harness owner).
- Anything that smells like a signing/format regression (receivers report
  invalid signatures across MANY endpoints after a deploy) → SEV2: freeze the
  deploy ([deploy.md](deploy.md) § Rollback Case A), Go backend lane — suspect
  `internal/webhooks/signing.go` changes, not the ladder.

## References

- [backend-go/internal/webhooks/attempts.go](../../backend-go/internal/webhooks/attempts.go) — ladder, WillRetry/BackoffFor, terminal rules
- [backend-go/internal/webhooks/worker.go](../../backend-go/internal/webhooks/worker.go) — claim lease, delivery timeout, graceful shutdown, at-least-once
- [backend-go/internal/webhooks/store.go](../../backend-go/internal/webhooks/store.go) — `claimDueSQL` (the due/lease predicate)
- [db/migrations/0012_webhooks.sql](../../db/migrations/0012_webhooks.sql) — `webhook_state` enum, terminal-shape CHECKs, idempotent enqueue
- [src/domain/webhooks/attempts.ts](../../src/domain/webhooks/attempts.ts) — the TS spec the ladder ports 1:1

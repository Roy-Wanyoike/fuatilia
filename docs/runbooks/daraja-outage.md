# Runbook — Daraja (Safaricom) outage: queue-and-replay

Scope: anything between Fuatilia and Safaricom Daraja — STK push initiation,
C2B validation/confirmation callbacks, B2C payouts, transaction status. The
production client is `backend-go/internal/daraja/` (issue #96); its error
taxonomy and operator reflexes are in
[backend-go/internal/daraja/README.md](../../backend-go/internal/daraja/README.md).
Entry point: [on-call-triage.md](on-call-triage.md).

> **Validated.** The payment-state SQL below was executed against PostgreSQL
> 16.4 with migrations 0001–0015 applied. Client behavior is cited from
> `backend-go/internal/daraja/client.go` / `errors.go`.

## The model: PostgreSQL is the queue

Fuatilia's queue-and-replay stance for Daraja is **no in-memory queue, no
extra broker** — the truth store queues by construction (ADR-0002):

1. A payment exists as a row in `payments`
   ([db/migrations/0005_payments_matches.sql](../../db/migrations/0005_payments_matches.sql)):
   `payment_state` ∈ `('initiated','pending_confirmation','confirmed',
   'partially_allocated','allocated','unapplied','failed','reversed')`,
   `external_ref` = the Daraja transaction identity (at-least-once callback
   identity, K1). While Daraja is down, rows simply REMAIN in
   `initiated`/`pending_confirmation` — nothing is lost, nothing expires.
2. The client already retries in-process: exponential backoff with full
   jitter on **network/5xx only** (`client.go` — defaults `MaxRetries=3`,
   `RetryInit=200ms`, `RetryMax=2s`; 4xx business errors never retried;
   401 → re-auth-once via the single-flight token manager). Exhausted
   retries surface as `DARAJA_RETRY_EXHAUSTED` (kind `upstream`).
3. Every consequential domain change appends an outbox row in the SAME
   transaction (0013), so downstream effects (webhooks, projections) flow
   whenever the relay runs — they never depend on Daraja being up.

**Honest wiring note:** `internal/daraja` has no consumers outside its package
yet (grep-verified on main @ 5280e0a) — the Go transport mounts the intake
side (`/v1/payments/intake`, `internal/daraja/callbacks.go` + `intake.go`),
while outbound STK initiation execution is still the TS spec lane
(`src/adapters/daraja/`). The re-drive loop in Remediation step 3 therefore
runs through the domain's own re-initiation path (spec: `src/adapters/daraja/`)
until the Go execution wiring lands (tracked in the #144 follow-up ledger —
file a dedicated issue before wiring). The sibling KRA eTIMS numbering source
has the same outage shape (`ETIMS_VSDC_PROVIDER_OUTAGE`,
`src/adapters/etims/`).

## Symptoms

- `kind=upstream` / `kind=network` / `kind=timeout` codes in api logs:
  `DARAJA_RETRY_EXHAUSTED`, `DARAJA_NETWORK_FAILED`, `DARAJA_API_ERROR`
  (5xx / `5*` errorCodes), `DARAJA_DEADLINE_EXCEEDED`
  (`backend-go/internal/daraja/errors.go` `kindForCode`/`kindForUpstream`).
- STK pushes never reach handsets; C2B confirmations go quiet.
- Payments pile up in the non-terminal states (SQL below).
- NOT an outage: `kind=auth` (`DARAJA_AUTH_FAILED`, `401.*`/`403.*`) —
  that is a credentials incident (re-provision secrets), see Escalation.

## Diagnosis

```sql
-- P1. Intake posture: which states is money stuck in?
SELECT state, count(*) FROM payments GROUP BY state ORDER BY 2 DESC;

-- P2. The outage queue: initiations awaiting Daraja (age matters)
SELECT count(*) AS stuck, min(initiated_at) AS oldest
FROM payments WHERE state IN ('initiated','pending_confirmation');

-- P3. The same queue per org (who is bleeding)
SELECT o.slug, p.state, count(*), min(p.initiated_at) AS oldest
FROM payments p JOIN orgs o ON o.id = p.org_id
WHERE p.state IN ('initiated','pending_confirmation')
GROUP BY o.slug, p.state ORDER BY oldest;
```

```sh
# Error classes over the outage window (ids + messages only in logs)
docker compose logs --since=1h api 2>/dev/null | grep -E 'DARAJA_[A-Z_]+' | grep -oE 'DARAJA_[A-Z_]+' | sort | uniq -c
```

Classify before acting (the README's operator-reflex table):

| Kind | Codes (examples) | Meaning | Reflex |
|---|---|---|---|
| `network` | `DARAJA_NETWORK_FAILED` | transport unreachable | outage likely — this runbook |
| `upstream` | `DARAJA_API_ERROR` (5xx, `5*` errorCodes), `DARAJA_RETRY_EXHAUSTED` | Daraja unhealthy / contract-violating | outage likely — this runbook |
| `timeout` | `DARAJA_DEADLINE_EXCEEDED` | deadline expired (incl. during backoff) | retry with fresh deadline — outage likely |
| `auth` | `DARAJA_AUTH_FAILED`, `401.*`/`403.*` | credentials/permission | NOT an outage → secrets incident |
| `validation` | `400.*` errorCodes, payload refusals | untrusted input refused | dead-letter; never retry — not an outage |
| `money` | amount shapes, whole shillings, tamper mismatch | money-boundary refusal | alert finance; never retry |

## Remediation (queue-and-replay)

1. **Confirm the outage** — check Safaricom's status channels / hit the
   sandbox health with a manual, ONE-OFF probe (`DARAJA_BASE_URL` in `.env`;
   default `https://sandbox.safaricom.co.ke`). Do not loop probes: the client
   already backs off with jitter.
2. **Freeze expectations, not data.** No writes need blocking: intake keeps
   landing truth in PG, the outbox keeps flowing, webhooks keep delivering.
   Communicate the degradation to affected orgs (P3 gives the list).
3. **Replay after recovery** — in order:
   a. Verify Daraja health (step 1 probe returns cleanly).
   b. Re-drive stuck initiations through the domain's re-initiation path —
      the queue is `state IN ('initiated','pending_confirmation')` (P2/P3;
      `idx_payments_state` on `(org_id, state)` is literally documented in
      0005 as "the reconciliation queue scans by state").
   c. Resolve ambiguous outcomes with the client's query paths — STK query
      (`internal/daraja/stk.go`) and B2C transaction status
      (`internal/daraja/b2c.go`) — BEFORE assuming failure. **Unknown STK
      result codes fail closed** (`STK_RESULT_<code>`, never mapped to money);
      failure results carry NO amount, and the parse refuses without the
      merchant's own initiation record as evidence
      (`DARAJA_STK_AMOUNT_UNKNOWN`). Money truth is only ever the PG row.
   d. Watch the downstream chain resume on its own: relay drains
      ([outbox-lag.md](outbox-lag.md) Q1/Q5) and receivers get webhooks per
      the ladder ([webhook-failure-burst.md](webhook-failure-burst.md)).
4. **If the outage poisons the outbox instead** (broker-side confusion during
   the incident): that is the DLQ path — [dlq-drain.md](dlq-drain.md).
5. **Never** re-issue a payment by inserting rows or re-running intake for the
   same `external_ref` by hand: idempotency is structural
   (`uq_idempotency_keys (org_id, scope, key)` + `uq_payments` external-ref
   discipline in 0005; R9 at-least-once intake, `internal/daraja/intake.go`).

## Escalation

- `kind=auth` codes → secrets incident: integrations lane re-provisions
  Daraja consumer key/secret (env-only; never in files, logs or tickets —
  `.env.example` carries the `CHANGE_ME` placeholders, nothing else).
- `kind=money` codes → finance on-call + orchestrator: a money-boundary
  refusal is a stop-the-line signal, not a retry.
- Outage > 4h with P2 growing across many orgs → inform collections owners:
  dunning schedules downstream are NOT yet automated (the Go scheduler, issue
  #126, is open) — human follow-up on customer communication is manual today.
- Daraja contract violations (malformed responses — `kind=upstream` with
  `DARAJA_WIRE_MALFORMED`) after a Safaricom-side change → fintech
  integrations lane; capture the `UpstreamCode` values from logs (message
  text only, never payloads).

## References

- [backend-go/internal/daraja/README.md](../../backend-go/internal/daraja/README.md) — error taxonomy + operator reflexes, R9 semantics
- [backend-go/internal/daraja/client.go](../../backend-go/internal/daraja/client.go) — retry policy defaults, backoff+jitter
- [backend-go/internal/daraja/errors.go](../../backend-go/internal/daraja/errors.go) — codes → kinds (`kindForCode`, `kindForUpstream`)
- [backend-go/internal/daraja/callbacks.go](../../backend-go/internal/daraja/callbacks.go) — K1 untrusted-input boundary for callbacks
- [db/migrations/0005_payments_matches.sql](../../db/migrations/0005_payments_matches.sql) — `payment_state`, `idx_payments_state` reconciliation scan
- [docs/DECISIONS.md](../DECISIONS.md) — ADR-0002 (PG truth), ADR-0003 (replayable fabric)

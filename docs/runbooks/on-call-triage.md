# Runbook — On-call triage decision tree

Audience: whoever holds the pager. This is the ENTRY POINT for every incident;
it routes into the specific runbooks. Truth anchors: PostgreSQL is the only
financial source of truth (ADR-0002, [docs/DECISIONS.md](../DECISIONS.md));
the event fabric is rebuildable (ADR-0003).

## Non-negotiables before you touch anything

1. **Never** hand-edit financial tables (`payments`, `ledger_entries`,
   `allocations`, `audit_events`, …). The only sanctioned state mutations on
   operational tables are the ones the runbooks name (`worker replay …`,
   `UPDATE webhook_endpoints SET active = …`).
2. `audit_events` is append-only at the database level — UPDATE/DELETE raise
   `AUDIT_APPEND_ONLY` (trigger `trg_audit_events_guard`,
   `db/migrations/0013_audit_outbox.sql`).
3. Payloads may carry customer identifiers. Log lines already redact them
   (outbox/webhook workers log ids and counts only); do not paste row payloads
   into tickets or chats.
4. NATS/JetStream state loss is **not** data loss — truth replays from
   PostgreSQL (`docs/DEPLOY.md § Data & volumes`). Losing
   `fuatilia_pgdata` IS data loss → [backup-dr.md](backup-dr.md).

## Decision tree

```
Pager fired
│
├─ Is PostgreSQL reachable / pgdata volume intact?
│    NO  → SEV1 → backup-dr.md (Restore) + deploy.md (Case B)
│    YES ↓
├─ Does `make smoke` pass all 4 probes?
│    NO  → deploy.md (verify / Case C)
│    YES ↓
├─ Is money flow stalled?
│    ├─ Webhook deliveries backing up / dead-lettering?
│    │     → webhook-failure-burst.md
│    ├─ Outbox pending rows growing / worker poisoned rows?
│    │     → outbox-lag.md  (then dlq-drain.md if status='poisoned')
│    └─ Daraja (Safaricom) errors in api logs, STK/C2B stuck?
│          → daraja-outage.md
│    none of these ↓
├─ Observability gap (need metrics/traces that are not wired yet)?
│     → observability.md  (lists what IS wired vs follow-ups)
│    else ↓
└─ Unknown/other → gather the triage pack below and escalate.
```

## Severity ladder

| Sev | Meaning | Examples | Response |
|-----|---------|----------|----------|
| SEV1 | Financial truth at risk | `fuatilia_pgdata` lost/corrupt; restore produced divergence; audit chain integrity question | Page orchestrator + db lane immediately; freeze writes |
| SEV2 | Money flow stalled but truth safe | outbox lag growing; Daraja outage; webhook endpoint down; worker crash-looping | On-call drives the matching runbook now |
| SEV3 | Degradation, no stall | single receiver failing its ladder; elevated 5xx on one route | Drive runbook, ticket if absorbed by retries |
| SEV4 | Cosmetic / noise | log volume, one-off 401 investigation | Ticket |

## First 5 minutes — the triage pack

Run in order; each answer routes you.

```sh
# 1. Stack posture (needs Docker engine on the host)
docker compose ps
make smoke

# 2. Recent errors across services (stdout JSON is the aggregation story)
docker compose logs --since=15m 2>&1 | grep -Ei 'error|poisoned|unreachable|failed' | tail -50
```

```sql
-- 3. Backlog + DLQ at a glance (schema: db/migrations/0013_audit_outbox.sql;
--    the lag probe mirrors relay.go pendingLag verbatim)
SELECT count(*) AS lag_rows,
       COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)))::bigint, 0) AS oldest_pending_seconds
FROM outbox_events WHERE status = 'pending';

SELECT count(*) AS dlq_depth FROM outbox_events WHERE status = 'poisoned';

-- 4. Webhook pressure (schema: db/migrations/0012_webhooks.sql)
SELECT state, count(*) FROM webhook_deliveries GROUP BY state ORDER BY 2 DESC;
SELECT count(*) AS stuck_delivering FROM webhook_deliveries
 WHERE state = 'delivering' AND updated_at <= now() - interval '2 minutes';  -- claim lease

-- 5. Money-flow intake posture (schema: db/migrations/0005_payments_matches.sql)
SELECT state, count(*) FROM payments GROUP BY state ORDER BY 2 DESC;
```

Routing table for what you find:

| Finding | Runbook |
|---|---|
| `lag_rows` high or `oldest_pending_seconds` > ~60s | [outbox-lag.md](outbox-lag.md) |
| `dlq_depth` > 0 | [dlq-drain.md](dlq-drain.md) |
| `webhook_deliveries` failed/dead_lettered spike | [webhook-failure-burst.md](webhook-failure-burst.md) |
| stuck_delivering > 0 | [webhook-failure-burst.md](webhook-failure-burst.md) § Diagnosis (lease recovery) |
| payments piling in `initiated`/`pending_confirmation` + Daraja errors | [daraja-outage.md](daraja-outage.md) |
| compose service unhealthy / migrate failed | [deploy.md](deploy.md) |
| "I need a metric/dashboard" | [observability.md](observability.md) |

## Escalation

1. **On-call (you):** drive the matching runbook end to end; timestamp every
   action; include SQL outputs (ids and counts, not payloads) in the incident
   channel.
2. **Orchestrator:** any SEV1, any case where you would run a mutation not
   listed in a runbook, any restore, any rollback (deploy.md Case B).
3. **Lane owners (by area):** outbox/relay + worker → Go backend lane;
   webhook endpoints/receivers → integrations lane; Daraja/Safaricom →
   fintech-integrations lane (they hold the Safaricom escalation contact —
   credentials live in the secret manager, never in tickets).
4. **Record:** after-action note appended to the incident channel; if a
   runbook step was wrong or missing, fix the runbook in the same PR series
   (docs lane, `docs/runbooks/`).

## References

- [docs/DECISIONS.md](../DECISIONS.md) — ADR-0002 (PG truth), ADR-0003 (outbox → JetStream)
- [docs/07-invariants.md](../07-invariants.md) — R1–R10 (money, audit, idempotency)
- [db/migrations/0013_audit_outbox.sql](../../db/migrations/0013_audit_outbox.sql) — outbox/audit/idempotency DDL
- [db/migrations/0012_webhooks.sql](../../db/migrations/0012_webhooks.sql) — webhook delivery DDL
- [docs/ops/CI-BILLING-BLOCKER.md](../ops/CI-BILLING-BLOCKER.md) — CI is non-executing; local green is the gate (affects what "deployed green" means)

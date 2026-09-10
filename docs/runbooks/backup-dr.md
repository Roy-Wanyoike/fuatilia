# Runbook — Backup & DR: verified pg_dump procedure + RPO/RTO

Scope: PostgreSQL — the ONLY thing that needs backing up. NATS JetStream
state is rebuildable by design: losing the `fuatilia_nats` volume costs
delivery buffering only; truth replays deterministically from PostgreSQL
(ADR-0003; [docs/DEPLOY.md § Data & volumes](../DEPLOY.md),
[docker-compose.yml](../../docker-compose.yml) volume comments). Entry point:
[on-call-triage.md](on-call-triage.md).

> **Verified procedure.** The dump → manifest → test-restore → row-count
> verification below was EXECUTED END-TO-END during authoring against
> PostgreSQL 16.4 (`pg_dump`/`pg_restore` 16.4): a database carrying
> migrations 0001–0015 plus seeded financial-shape rows round-tripped with
> exact row counts (`outbox_events=6`, `webhook_deliveries=7`,
> `schema_migrations=15`).

## Honest RPO/RTO statement (read before promising numbers)

| | Current reality | What buys you better |
|---|---|---|
| **RPO** | = time since the last **verified** backup. Backups are manual today — no scheduled job, no off-host copy, no WAL archiving ([docs/DEPLOY.md § honest ledger](../DEPLOY.md), gap 4). With no schedule, RPO is **unbounded** — do not quote a number nobody scheduled. | Schedule the backup command (cron/systemd timer on the Docker host) — RPO becomes the cadence. PITR/WAL archiving is NOT available and is a deliberate gap; do not promise point-in-time recovery. |
| **RTO** | fresh cluster + `pg_restore` + verification + cutover. Components measured on the authoring sample: restore seconds-scale for a small DB — scales roughly linearly with dump size; the dominant real-world terms are volume re-provisioning, decision time and the restore drill being **rehearsed**. | Quarterly restore drill (below) keeps RTO = measured, not hoped. |

Compensating controls that bound real damage despite the gaps:
forward-only idempotent migrations (schema is reconstructible), the outbox
replay primitive for consumers (`worker replay --from --to`), and
at-least-once consumers everywhere (idempotent by eventId, R9).

## Backup procedure (with verification — a dump without a verified restore is a hope, not a backup)

Run on the Docker host (authenticates with `POSTGRES_PASSWORD` via scram —
does NOT depend on the compose trust-auth posture, `docs/DEPLOY.md`):

```sh
# 1. Consistent logical snapshot (custom format; single transaction)
source .env   # POSTGRES_USER / POSTGRES_DB
docker compose exec postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "fuatilia-$(date -u +%Y%m%dT%H%M%SZ).dump"

# 2. VERIFY-1: the archive is structurally complete and readable
pg_restore --list "fuatilia-<TS>.dump" > "fuatilia-<TS>.manifest.txt"   # exit 0, non-empty TOC

# 3. VERIFY-2: test-restore into a THROWAWAY database (never straight over prod)
createdb -h <pg-host> -U <user> fuatilia_drill
pg_restore -h <pg-host> -U <user> -d fuatilia_drill --no-owner "fuatilia-<TS>.dump"

# 4. VERIFY-3: assertions — migration completeness + row-count parity vs source
psql -h <pg-host> -U <user> -d fuatilia_drill -tA -c \
  "SELECT count(*) FROM schema_migrations;"          # must equal db/migrations/*.sql file count
for t in orgs payments ledger_entries outbox_events audit_events webhook_deliveries idempotency_keys; do
  src=$(psql -h <pg-host> -U <user> -d "$POSTGRES_DB" -tA -c "SELECT count(*) FROM $t")
  dst=$(psql -h <pg-host> -U <user> -d fuatilia_drill  -tA -c "SELECT count(*) FROM $t")
  echo "$t: $src vs $dst"; [ "$src" = "$dst" ] || echo "MISMATCH: $t"
done

# 5. Ship the dump OFF-HOST (encrypted storage) and drop the drill DB
dropdb -h <pg-host> -U <user> fuatilia_drill
```

Verification failure at ANY step = no valid backup exists. Treat it as SEV2
until a fresh verified dump succeeds ([on-call-triage.md](on-call-triage.md)
severity ladder).

## Restore procedure

Drill-first (recommended even during an incident — never overwrite the
evidence until the new cluster is proven):

```sh
# a. Restore into a fresh scratch cluster/database as in VERIFY-2 above; run VERIFY-3.
# b. Cut over:
docker compose down                                    # stop the stack; keep evidence volume
docker volume rm fuatilia_fuatilia_pgdata              # only after the drill passed
docker compose up -d postgres
cat "fuatilia-<TS>.dump" | \
  docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists
docker compose up -d                                   # migrate job will no-op (schema_migrations restored)
make smoke
```

([docs/DEPLOY.md § Backup & restore](../DEPLOY.md) is the source of the
cutover block; the drill-first variant adds the safety the gap ledger demands.)

After any restore: run the outbox/webhook posture checks
([outbox-lag.md](outbox-lag.md) Q1/Q6, [webhook-failure-burst.md](webhook-failure-burst.md)
W1/W4) and spot-check the newest `audit_events` rows against the incident
timeline. Consumers replay at-least-once — dedupe is their contract.

## What NOT to restore / back up

- `fuatilia_nats` volume: rebuildable; re-creating it empty is CORRECT
  (at-least-once redelivery buffering only). Never "restore" JetStream state
  over a fresh PG — PG is the truth, the stream re-fills from the relay.
- Dump handling: dumps contain financial records and customer identifiers —
  encrypted storage only, never committed, never pasted. The repo stays
  secret-free (`.gitignore` covers `.env`; dumps are not code — keep them off
  every clone).

## Escalation

- pgdata volume loss / PG corruption → SEV1: freeze writes (stop `api` via
  `docker compose stop api` if writes must not land), orchestrator + db lane
  on the bridge, then this runbook's restore with BOTH engineers present.
- VERIFY-3 row-count mismatch → SEV2: do NOT cut over; source-of-truth
  divergence investigation (compare per-table counts, then newest ids/
  timestamps) before any further action.
- Restore succeeded but consumers report duplicates outside the 2-minute
  dedup window → Go backend lane ([outbox-lag.md](outbox-lag.md) escalation).

## References

- [docs/DEPLOY.md](../DEPLOY.md) § Data & volumes / Backup & restore / honest ledger (gaps)
- [docker-compose.yml](../../docker-compose.yml) — named volumes `fuatilia_pgdata`, `fuatilia_nats`
- [backend-go/internal/outbox/replay.go](../../backend-go/internal/outbox/replay.go) — deterministic consumer re-feed primitive
- [db/README.md](../../db/README.md) — migration suite semantics (`schema_migrations` completeness check)
- [docs/DECISIONS.md](../DECISIONS.md) — ADR-0002, ADR-0003

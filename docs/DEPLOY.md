# DEPLOY — standing the platform up (issue #75)

The deployment foundation: containers, a compose stack and the environment
contract. This records the minimal production topology — **PostgreSQL (truth)
+ NATS JetStream (fabric) + api + worker + a one-shot migrate job** — per
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) P0 criterion 7 and
"complexity is earned" (VISION §5). Kubernetes is deliberately out of scope.

Design anchors: [DECISIONS.md](DECISIONS.md) ADR-0001 (TS spec / Go port),
ADR-0002 (PostgreSQL is the only financial truth), ADR-0003 (transactional
outbox → NATS JetStream, at-least-once), ADR-0004 (Temporal for durable
workflows — not part of this compose stack), ADR-0005 (AI never mutates
financial truth).

## Quickstart

```sh
cp .env.example .env
# Generate a real password and put it in .env (both POSTGRES_PASSWORD and the
# DATABASE_URL password field):
openssl rand -hex 24
docker compose up --build          # first run builds the api + worker images
curl -fsS http://localhost:8080/v1/health
docker compose logs -f             # everything logs to stdout
```

`docker compose up` starts postgres, waits for its healthcheck, runs the
one-shot `migrate` job, and only then starts `api` and `worker`
(`depends_on` conditions in [docker-compose.yml](../docker-compose.yml)
enforce the ordering; a failed migration keeps the binaries down).

## Service map

| Service | Image (pinned) | Role | State | Published ports |
|---|---|---|---|---|
| `postgres` | `postgres:16.4-alpine` | The only financial source of truth (ADR-0002) | named volume `fuatilia_pgdata` | none |
| `nats` | `nats:2.11.17-alpine` | Event fabric, JetStream enabled (`-js`), at-least-once (ADR-0003) | named volume `fuatilia_nats` | none |
| `migrate` | `node:22-alpine` | One-shot: applies `db/migrations/*.sql` forward-only via `db/migrate.cjs`; applied files are recorded in `schema_migrations` and skipped on re-run | — (idempotent job) | none |
| `api` | built locally, `backend-go/Dockerfile` target `api` | Go `/v1` HTTP service (issue #72); `HEALTHCHECK` probes its own `/v1/health` | stateless | `8080:8080` — the only published port |
| `worker` | built locally, `backend-go/Dockerfile` target `worker` | Outbox relay: drains the transactional outbox table → NATS JetStream (issue #74, ADR-0003) | cursor state in PostgreSQL | none |

Only `api` is reachable from the host. PostgreSQL and NATS are internal to
the compose network — nothing else needs to reach them, so nothing else is
exposed.

## Environment contract

Compose interpolates everything from the environment (`docker compose`
auto-loads `./.env`); no service reads config any other way and no secrets
are baked into images. `.env.example` is the committed contract — the
placeholders marked `CHANGE_ME` must be generated (`openssl rand -hex 24`)
before the first `up`. `.env` is gitignored (`.gitignore` carries `.env` /
`.env.*` with an explicit `!.env.example`).

| Variable | Read by | Default in `.env.example` | Notes |
|---|---|---|---|
| `POSTGRES_USER` | postgres, migrate | `fuatilia` | initialized at first boot |
| `POSTGRES_DB` | postgres, migrate | `fuatilia` | initialized at first boot |
| `POSTGRES_PASSWORD` | postgres | `CHANGE_ME__RUN_openssl_rand_hex_24` | **required, never defaulted**; must equal the password inside `DATABASE_URL` |
| `DATABASE_URL` | api, worker | `postgres://fuatilia:CHANGE_ME…@postgres:5432/fuatilia?sslmode=disable` | pgx (Go) connection string; `sslmode=disable` is a compose-network-only setting — see the TLS gap below |
| `LISTEN_ADDR` | api | `0.0.0.0:8080` | the `8080:8080` mapping and the image HEALTHCHECK assume port 8080 — change all three together |
| `FUATILIA_PG_MAX_CONNS` | api | `10` | pgxpool `MaxConns` (persistence-adapters contract, issues #72/#73) |
| `FUATILIA_PG_MAX_CONN_LIFETIME` | api | `30m` | pgxpool `MaxConnLifetime` (Go duration) |
| `FUATILIA_PG_MAX_CONN_IDLE_TIME` | api | `5m` | pgxpool `MaxConnIdleTime` (Go duration) |
| `NATS_URL` | worker | `nats://nats:4222` | JetStream endpoint (compose DNS) |
| `OUTBOX_BATCH` | worker | `100` | events claimed per poll |
| `OUTBOX_POLL_INTERVAL` | worker | `1s` | sleep between polls when the outbox is empty (Go duration) |
| `OUTBOX_MAX_ATTEMPTS` | worker | `5` | attempts per event before it is parked for inspection; at-least-once means consumers stay idempotent regardless |

The contract is mechanically enforced: `scripts/validate_deploy.py` fails on
drift in either direction — every env var referenced by compose
(`${VAR}` interpolation) **or** read from Go code (`os.Getenv` /
`os.LookupEnv` in `backend-go/`) must have a committed `.env.example` key.
Adding a read without documenting it breaks the validator.

### Why trust auth in this compose (read before hardening)

`db/pgclient.cjs` — the stdlib-only PostgreSQL wire client used by
`db/migrate.cjs` — speaks **trust authentication only by design** ("SASL/md5
auth is refused loudly rather than half-supported", see its header). The
dev/staging compose therefore initializes the cluster with
`POSTGRES_HOST_AUTH_METHOD=trust` so the migrate job can connect. Bounds of
that decision:

- the postgres port is **not published**; trust is unreachable from outside
  the compose network;
- `POSTGRES_PASSWORD` is still set on the cluster, so the scram-capable
  paths (Go/pgx via `DATABASE_URL`, `psql`, `pg_dump`) authenticate
  normally — nothing to unwind when the migration runner gains SASL or moves
  into the Go binary;
- this is a dev/staging posture. Any internet-reachable deployment must put
  PostgreSQL behind proper secret-managed credentials (audit §5.2.3) — see
  the explicit gaps below.

## Data & volumes

| Volume | Holds | Losing it costs |
|---|---|---|
| `fuatilia_pgdata` | every financial fact (ADR-0002): aggregates, ledger, outbox, audit records | **truth** — restore from backup |
| `fuatilia_nats` | JetStream stream state (delivery buffering) | nothing durable: facts replay deterministically from PostgreSQL (ADR-0003 `Outbox.replay()` contract); consumers re-deliver at-least-once |

## Backup & restore

PostgreSQL is the only thing that needs backing up (NATS state is rebuildable,
per the table above).

```sh
# backup (logical, consistent snapshot)
docker compose exec postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "fuatilia-$(date -u +%Y%m%dT%H%M%SZ).dump"

# restore into a fresh cluster
docker compose down                       # keep the volume if you want to test in place
docker volume rm fuatilia_fuatilia_pgdata # start empty (project name prefix: `name: fuatilia`)
docker compose up -d postgres
cat fuatilia-TIMESTAMP.dump | \
  docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists
```

`pg_dump`/`pg_restore` authenticate with `POSTGRES_PASSWORD` (scram) — they
do not depend on the trust-auth posture. Automated off-host backups and
point-in-time recovery are **not** part of this foundation (see gaps).

## Upgrade path (the migrate job)

Migrations are forward-only and idempotent at the suite level
(`schema_migrations`): a file that is already recorded is skipped.

```sh
git pull                       # new migration files under db/migrations
docker compose up --build      # migrate runs first; api/worker wait for success
# re-run the schema job alone at any time (safe no-op when current):
docker compose run --rm migrate
```

A failing migration exits non-zero; `api`/`worker` never start against the
wrong schema (that is the point of `service_completed_successfully`).
Rollback is restore-from-backup — forward-only means no down-migrations by
design (R-invariant history is append-only, `docs/07-invariants.md`).

## Observability (documented plan, not scaffolding)

- **Logs:** every service logs to stdout; `docker compose logs -f [-t]` is
  the aggregation story. Structured JSON on stdout is the default plane the
  Go services ship with — no file shipping, no sidecars at this stage.
- **Health:** the `api` image carries a `HEALTHCHECK` against its own
  `GET /v1/health` (public route, no auth); `docker compose ps` surfaces it.
- **Metrics (wave-11 plan):** OpenTelemetry attaches here — the api and
  worker emit OTLP to a collector added as a compose service, with outbox
  lag and redelivery counts as the first two relay metrics ADR-0003 calls
  out as critical infrastructure. The compose file deliberately does not
  ship the collector yet; the attach points are the two Go binaries'
  environment, which is why this section exists instead of placeholder code.

## What is NOT covered (honest ledger)

This foundation is deliberately minimal. It does **not** include:

1. **TLS / ingress termination.** Plain HTTP inside the compose network;
   there is no proxy, no certificates. Audit §5.2.2 names TLS as missing
   before any production exposure.
2. **A secrets manager.** `DATABASE_URL`/`POSTGRES_PASSWORD` live in `.env`
   (gitignored). Daraja consumer keys, SMS credentials and webhook signing
   secrets have no home yet — `SecretCodec` is a seam only (audit §5.2.3);
   the roadmap puts a KMS/vault adapter behind that port in P0's security
   work.
3. **Rate limiting, security headers/CORS** — kernel-level gaps (audit
   §5.2.1/§5.2.5), not deployable via compose.
4. **Automated backups / PITR** — the commands above are manual; no
   scheduled job, no off-host copy, no WAL archiving.
5. **Externally-anchored audit storage** — the hash chain's head is only as
   durable as the PostgreSQL volume (audit §5.2.6).
6. **Temporal** — ADR-0004 puts durable workflows in P0's compose
   eventually; the stateful worker services are not part of this stack yet.
7. **The frontend** — issue #76 lands separately; it is not a dependency of
   this stack.
8. **Kubernetes / Terraform / Helm** — intentionally none ("complexity is
   earned", VISION §5); compose is the recorded topology until scale or
   compliance demands more.

## Validation — what is proven and what is not

**The build environment has no Docker daemon. Nothing here was executed
against a real engine.** `docker compose config`, image builds and container
startup were NOT run. What stands in their place, and its limits:

- `python3 scripts/validate_deploy.py` — the committed static gate (PyYAML;
  no hand-rolled parser fallback by design). It proves: the compose YAML
  parses; every build context, Dockerfile, host mount and
  entrypoint-referenced file exists; the service graph is acyclic with the
  required ordering; only `api` exposes ports; images are pinned (no
  `:latest`); the Dockerfile is multi-stage, `CGO_ENABLED=0`, nonroot, and
  healthchecks `/v1/health`; the `.env.example` ↔ compose ↔ backend-go env
  contract holds with no credential defaults. It cannot prove: that images
  build, binaries link, containers start, healthchecks pass, or migrations
  run — those need an engine.
- Base-image tags (`golang:1.26.8-alpine3.23`, `node:22-alpine`,
  `postgres:16.4-alpine`, `nats:2.11.17-alpine`, `busybox:1.37.0-musl`,
  `gcr.io/distroless/static-debian12:nonroot`) were verified to exist on
  their registries at authoring time. Digest-pinning is the next hardening
  step once a CI engine can rebuild against it.

**Parallel-lane ordering (stated plainly):** `backend-go/cmd/api` (issue
#72) and `backend-go/cmd/worker` (issue #74) are being built in parallel and
do not exist on this branch yet. The Dockerfile compiles those agreed paths;
until they merge, the validator runs with `--allow-pending-lanes`, which
downgrades exactly that one fact to an explicit PENDING. On the merged tree
the plain `python3 scripts/validate_deploy.py` must exit 0 — that is
acceptance criterion 1.

### CI-shaped note (for when the billing lock lifts)

CI is currently non-executing repo-wide (account billing lock —
[ENGINEERING_STATUS.md](ENGINEERING_STATUS.md)); local green is the merge
gate. When it unlocks, a `deploy.yml` (dispatcher-owned; not added here)
should run, per push: `pip install pyyaml` → `python3
scripts/validate_deploy.py` (strict, no flag) → `docker build --target api`
and `--target worker` → `docker compose config -q` → optionally the
`db/validate.sh` suite against a postgres service container. That closes the
gap between "statically consistent" and "boots" without any manual step.

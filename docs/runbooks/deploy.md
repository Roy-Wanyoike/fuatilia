# Runbook — Deploy: compose stack up, verify, rollback

Audience: the engineer on deploy duty. Topology truth: [docker-compose.yml](../../docker-compose.yml)
and [docs/DEPLOY.md](../DEPLOY.md) (issue #138/#154 stack). Escalation contract: [on-call-triage.md](on-call-triage.md).

> **Validation note.** Every command below is quoted from the committed
> `Makefile` / `docker-compose.yml` / `docs/DEPLOY.md`. The SQL and `worker`
> CLI paths in the sibling runbooks were executed against a real PostgreSQL
> 16.4 cluster during authoring; `docker compose` steps require a Docker
> engine (the authoring sandbox has none — that limitation is recorded in
> [docs/DEPLOY.md § Validation](../DEPLOY.md)).

## Symptoms (when to open this runbook)

- A deploy is scheduled, or a deploy just failed mid-boot (`make up` non-zero,
  a service restarting, `migrate` exited non-zero).
- Post-deploy smoke is red: `/v1/health` 5xx/down, web console not rendering,
  BFF seam not refusing 401 (it must refuse without a session — see smoke 4/4).

## Deployment procedure

### 0. Preflight (no Docker needed)

```sh
cp .env.example .env            # first deploy only; never commit .env
openssl rand -hex 24            # generate ONE secret, use it for BOTH keys below
#  .env: POSTGRES_PASSWORD=<hex>            (compose refuses to boot without it)
#  .env: DATABASE_URL=postgres://fuatilia:<hex>@postgres:5432/fuatilia?sslmode=disable
python3 scripts/validate_deploy.py
```

The static validator checks compose structure, pinned images, the boot graph
and the `.env.example` ↔ compose ↔ Go env contract. **Known failure at
authoring time (main @ 5280e0a):** it exits 1 with exactly one finding,
`missing: ['PATH']` — the issue-#154 env scanner counts Go's
`os.Getenv("PATH")` (in `backend-go/internal/infra/pgtest/pgtest.go`, a test
helper reading an OS-reserved variable) as a deployment contract key. This is
the cross-lane regression flagged in PR #162, not a deploy blocker; every
other gate in the validator is green. Fix (owner: deploy lane) is an
OS-reserved allowlist in `scripts/validate_deploy.py`.

### 1. Boot the stack

```sh
make up        # = docker compose up -d --build, after refusing CHANGE_ME .env
```

Boot order enforced by `depends_on` conditions in [docker-compose.yml](../../docker-compose.yml):

```
postgres (pg_isready healthcheck)
  └─► migrate (one-shot db/migrate.cjs; recorded files skipped on re-run)
        └─► api (image HEALTHCHECK probes /v1/health)      ◄─ nats healthy
              └─► frontend (waits api service_healthy)
nats (JetStream; /healthz on internal :8222) ─► worker (outbox relay)
```

A failed migration exits non-zero and `api`/`worker` never start against the
wrong schema (`service_completed_successfully`). Migrations are forward-only
(`db/migrations/*.sql`, recorded in `schema_migrations`).

### 2. Verify

```sh
make smoke
```

Four probes, each proving a different seam ([Makefile](../../Makefile) `smoke`):

1. `GET :8080/v1/health` — Go api answers with PostgreSQL behind it.
2. `GET :8080/v1/meta` — public capability list served.
3. `GET :3000/` — Next standalone server renders (expect 200).
4. `GET :3000/api/v1/health` — BFF seam **refuses 401 without a session**
   (fail-closed; 401 IS the pass).

Then `docker compose ps` (all services healthy / migrate exited 0) and
`docker compose logs -f --tail=200` (= `make logs`).

## Rollback

### Case A — bad release, schema unchanged

1. Identify the last good release tag ([CHANGELOG.md](../../CHANGELOG.md) maps
   releases to merged PRs; tags per [docs/RELEASE.md](../RELEASE.md)).
2. Check whether the release touched the schema:

   ```sh
   git diff --stat <last-good-tag>..<bad-tag> -- db/migrations/
   ```

   Empty output → schema is unchanged → image rollback is safe.
3. Roll back and rebuild:

   ```sh
   git checkout <last-good-tag>
   make up        # rebuilds fuatilia-api:local / fuatilia-worker:local / frontend from that tree
   make smoke
   ```

### Case B — the release applied migrations you must retreat from

Migrations are **forward-only by design** (append-only invariant history,
[docs/07-invariants.md](../07-invariants.md); `docs/DEPLOY.md § Upgrade path`):
there is no down-migration. A schema rollback **is a restore from backup** —
run [backup-dr.md](backup-dr.md) § Restore, then check out the last-good tag
and boot. Never hand-edit applied schema objects.

### Case C — single service misbehaving (not a release problem)

```sh
docker compose restart worker          # relay hiccup (then watch outbox lag — outbox-lag.md)
docker compose up -d --force-recreate api   # re-read .env / re-pick the image
docker compose run --rm migrate        # re-run the schema job alone (idempotent no-op when current)
```

## Escalation

- Migrate job fails repeatedly → **do not** retry `up` blindly; capture
  `docker compose logs migrate`, freeze deploys, page the db lane. A migration
  that fails mid-file was rolled back (one transaction per file —
  `db/README.md`), so re-running after a fix is safe.
- Post-rollback data mismatch (rows missing after Case B restore) → treat as
  potential financial-truth loss: SEV1 per [on-call-triage.md](on-call-triage.md),
  involve the orchestrator before any further writes.
- Everything else unresolved after the service-specific runbooks
  ([outbox-lag.md](outbox-lag.md), [webhook-failure-burst.md](webhook-failure-burst.md),
  [daraja-outage.md](daraja-outage.md)) → escalate per
  [on-call-triage.md](on-call-triage.md) § Escalation.

## References

- [docker-compose.yml](../../docker-compose.yml) — topology, healthchecks, boot conditions
- [Makefile](../../Makefile) — `up` / `down` / `logs` / `smoke` / `validate`
- [docs/DEPLOY.md](../DEPLOY.md) — design rationale, env contract, trust-auth bounds
- [scripts/validate_deploy.py](../../scripts/validate_deploy.py) — static deploy gate
- [docs/RELEASE.md](../RELEASE.md) / [CHANGELOG.md](../../CHANGELOG.md) — release tags for rollback targets

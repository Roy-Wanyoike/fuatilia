# CI Billing Blocker — GitHub Actions account lock (issue #139)

**Status: BLOCKED (account-level) — owner action required.** Every GitHub
Actions run fails in 3–6 seconds **before any workflow step executes**. This
is not a workflow defect: the runner never starts a job. The workflows have
been repaired and hardened on `w11c/ci-repair` so they are correct and ready
the moment billing clears (see [What was repaired meanwhile](#4-what-was-repaired-meanwhile-branch-w11cci-repair)).

## 1. Evidence

| Field | Value |
| --- | --- |
| Example run | [CI #34258007052](https://github.com/Roy-Wanyoike/fuatilia/actions/runs/34258007052) (triggered by a Dependabot PR) |
| Jobs | `domain (22)`, `domain (24)`, `frontend` — all `failure` with **zero executed steps** (check-run job id `102168583541`) |
| Annotation (exact) | `The job was not started because your account is locked due to a billing issue.` |
| Observed | Every run on every workflow, consistently failing in 3–6 s |
| Date observed | 2026-09-08 |

The annotation is emitted by GitHub itself, before `actions/checkout` or any
other step can run. No change to `.github/workflows/**` can fix it — it is a
payment-profile lock on the account that owns the repository.

## 2. How to unblock (OWNER ACTION — cannot be delegated)

1. Sign in as **Roy-Wanyoike** (the account that owns the repo / payment profile).
2. Open **Settings → Billing and licensing** (older navigation names it
   *Billing and plans*) → **Payment information**.
3. Resolve whatever GitHub flags there — typically one of:
   - a **declined card / failed charge**: update the payment method or retry the payment;
   - an **unpaid balance**: pay the outstanding invoice;
   - a **spending limit** that blocks Actions usage: raise or confirm it.
4. If the billing UI shows everything paid but the lock persists, open a
   ticket with [GitHub Support](https://support.github.com/request) — the lock
   can persist server-side after a payment fix and only support can lift it.
5. Verify the lock is gone by starting a run that does not need a PR:
   ```bash
   gh workflow run ci.yml --repo Roy-Wanyoike/fuatilia --ref main
   gh run watch --repo Roy-Wanyoike/fuatilia $(gh run list --repo Roy-Wanyoike/fuatilia --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```
   (`go.yml` and `db.yml` also accept `gh workflow run` — all three workflows
   now carry `workflow_dispatch`.)

The first post-unblock run is the real validation of this branch's workflows:
until the lock lifts, **no workflow in this repository has actually executed
on Actions**, and nothing here claims otherwise.

## 3. Local gates meanwhile (full parity with CI)

The CI jobs are built to mirror the local merge gate exactly, so all gates can
be run locally while Actions is locked. Prereqs already provisioned in this
workspace: portable **PostgreSQL 16.4** binaries at `/home/z/tools/pg164/bin`
(symlinked from `/home/z/my-project/tools/pg164/bin`), Go + gh toolchains
under `/home/z/tools/`.

**0. Boot the lane cluster on port 5435** (trust auth; creates
`fuatilia_pgadapters_test`, `fuatilia_smoke`, `fuatilia_dev`; idempotent):

```bash
bash /home/z/my-project/scripts/boot_pg.sh
# ready check:
/home/z/tools/pg164/bin/pg_isready -h 127.0.0.1 -p 5435
```

**1. TS domain suite (mirrors ci.yml `domain` job):**

```bash
cd /home/z/my-project/agents/ci-139/fuatilia   # or any checkout
export FUATILIA_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test'
export FUATILIA_TEST_PGBIN=/home/z/tools/pg164/bin
export FUATILIA_PG_BIN_DIR=/home/z/tools/pg164/bin
npm ci --no-audit --no-fund
npm run typecheck
npm test            # vitest run — the PG-backed specs FAIL if the cluster is down (no silent skips)
```

**2. Frontend (mirrors ci.yml `frontend` job):**

```bash
cd frontend
npm ci --no-audit --no-fund
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

**3. Go backend (mirrors go.yml `test` job — same order):**

```bash
cd backend-go
test -z "$(gofmt -l .)"          # must print nothing
go vet ./...
# migrate the DB the outbox suite seeds directly (same command CI runs; idempotent):
PGHOST=127.0.0.1 PGPORT=5435 PGUSER=postgres PGDATABASE=fuatilia_pgadapters_test \
  node db/migrate.cjs
export FUATILIA_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test'
export FUATILIA_TEST_PGBIN=/home/z/tools/pg164/bin
go test ./... -race -count=1
```

For the Go API-kernel lane database specifically, the committed human
equivalent of `pgtest.RequireShared` is
`backend-go/internal/infra/testdata/boot-api-lane.sh` (initdb + start on 5435 +
create `fuatilia_api_test` + apply migrations).

**4. DB schema suite (mirrors db.yml `migrations` job):**

```bash
bash db/validate.sh            # boots its own throwaway cluster on 55432, no service needed
# or, against an already-running empty database:
PGHOST=127.0.0.1 PGPORT=<port> PGUSER=<user> PGDATABASE=<db> bash db/validate.sh --ci
```

## 4. What was repaired meanwhile (branch `w11c/ci-repair`)

No application code was touched — only `.github/workflows/**` and this doc.

| File | Repair / hardening |
| --- | --- |
| `.github/workflows/ci.yml` | `workflow_dispatch`; `concurrency` group per ref with `cancel-in-progress`; `timeout-minutes` on both jobs; runner pinned to `ubuntu-24.04` (guarantees `apt postgresql-16` availability); action majors verified via the GitHub API (`actions/checkout@v7` = v7.0.1, `actions/setup-node@v7` = v7.0.0 — both real releases); step that hard-asserts `initdb`/`pg_ctl` exist at `/usr/lib/postgresql/16/bin`; frontend job runs the real scripts (`npm run typecheck`, `npm test` = vitest run) instead of `--if-present`; env-var contract documented with the exact reading files. PG 16 service on host port **5435** wired with `FUATILIA_TEST_DATABASE_URL` + `FUATILIA_PG_BIN_DIR` (+ `FUATILIA_TEST_PGBIN` for contract parity). |
| `.github/workflows/go.yml` | **PG 16 service added** (was absent — the Go suites hard-fail without it): postgres:16, trust auth, host port **5435**; `workflow_dispatch`; `concurrency` + `timeout-minutes: 40`; `paths` extended with `db/migrations/**` (the Go suites apply them); PostgreSQL 16 binaries installed and asserted; **migrations applied to the service DB via `db/migrate.cjs`** before `go test` (the outbox suite truncates/seeds `FUATILIA_TEST_DATABASE_URL` directly and does not self-migrate); gofmt → vet → `test -race -count=1` → govulncheck order kept. |
| `.github/workflows/db.yml` | **`POSTGRES_HOST_AUTH_METHOD: trust` added** — without it the image defaults to scram-sha-256 and `db/pgclient.cjs` (stdlib-only wire client used by `db/migrate.cjs`/`db/smoke.cjs`) aborts with `unsupported auth request … speaks trust auth only` (`db/pgclient.cjs:117-121`), so the job could never pass once started; `workflow_dispatch`; `concurrency` + `timeout-minutes: 15`; runner pinned to `ubuntu-24.04`. |

### Env-var contract — exactly what the code reads

| Variable | Value in CI | Read by (code of record) |
| --- | --- | --- |
| `FUATILIA_TEST_DATABASE_URL` | `postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test` | `src/adapters/persistence/pg/testutil.ts:34` (`TEST_DATABASE_URL_ENV`; default at :37); `backend-go/internal/outbox/testmain_test.go:33`; `backend-go/internal/transport/integration_test.go:55` |
| `FUATILIA_TEST_PGBIN` | `/usr/lib/postgresql/16/bin` | `backend-go/internal/infra/pgtest/pgtest.go:44` (`EnvPGBin`), :386 (`PGBin()`) — `RequireShared` requires `pg_ctl`/`postgres` there; `StartTemp` shells out to `initdb` (restart-resilience suites: `internal/infra`, `internal/webhooks`) |
| `FUATILIA_PG_BIN_DIR` | `/usr/lib/postgresql/16/bin` | `src/adapters/persistence/pg/testutil.ts:222` (`PG_BIN_DIR_ENV`) — ephemeral-cluster (down/up/crash) specs run `initdb`/`pg_ctl` from it |

Both PG-wired jobs export all three variables so the service contract is
identical in `ci.yml` and `go.yml`; the table above is the authoritative
reader mapping (each workflow file also cites it inline).

## 5. Validation performed on this branch

- All three workflow files parse cleanly (`python3 -c "import yaml; yaml.safe_load(...)"`).
- Action majors verified against the GitHub API, not assumed: `actions/checkout`
  tags include `v7`/`v7.0.0`/`v7.0.1`; `actions/setup-node` and
  `actions/setup-go` both include `v7`/`v7.0.0`.
- The exact `db/migrate.cjs` invocation used in `go.yml` was executed against a
  live PG 16.4 cluster on `127.0.0.1:5435` (idempotent: `0 applied, 14 skipped`).
- `gofmt`/`vet`/`test -race` and the vitest suites remain runnable locally
  (§3) — they are the same commands CI runs.
- **Not yet validated (honestly): an actual GitHub Actions run** — impossible
  while the account is locked; see §1.

# CONTRIBUTING — the engineering handbook

> How to ship a change to Fuatilia: contract, gates, discipline, and a
> worked end-to-end example. Everything here is enforced somewhere — each
> rule cites the code or workflow that enforces it.
>
> For the system itself, read [ARCHITECTURE.md](ARCHITECTURE.md). For design
> docs, start at [README.md](README.md).

---

## 1. Ground rules (non-negotiable)

1. **No fake production.** No TODO/FIXME markers, no mocks in production
   paths, no placeholder credentials. Fakes and scripted servers live in
   test files only (`*_test.go`, `*.spec.ts`).
2. **No secrets, ever.** `.env` is gitignored; `.env.example` carries
   `CHANGE_ME` placeholders only. The deploy validator
   ([scripts/validate_deploy.py](../scripts/validate_deploy.py)) and review
   secret-scans enforce this.
3. **AI never owns financial truth.** Only fund-truth lanes move money, and
   only through the policy → approval → audit rails
   ([DECISIONS.md](DECISIONS.md) ADR-0005,
   [07-invariants.md](07-invariants.md)).
4. **The suites never lie.** Tests do not skip silently when infrastructure
   is missing — they **fail loudly**. A green run against a database that
   was not there would be a lie (this is enforced in code, see §4).

---

## 2. Environment setup (fresh clone)

### 2.1 Toolchain

| Tool | Version | Notes |
|---|---|---|
| Node | ≥ 22 (CI matrix runs 22 and 24) | `package.json` `engines`; frontend has its own manifest |
| Go | 1.26 (matches `backend-go/go.mod`) | `gofmt`, `go vet`, `go test -race` are gates |
| PostgreSQL | **16** (16.4 used in this workspace) | Real server — the test suites run against it and refuse to skip |
| Docker + compose v2 | any recent | Only for `make up/down/logs/smoke` — not needed for the gates |
| Python 3 | any | Only for the two static validators |

```bash
git clone https://github.com/Roy-Wanyoike/fuatilia.git
cd fuatilia
npm ci                    # root TS core
npm ci --prefix frontend  # web console
cd backend-go && go mod download
```

### 2.2 PostgreSQL for the test suites

Any PostgreSQL 16 installation works. The suites resolve the server's
binaries through a discovery ladder (issue #131 removed every hardcoded
install path) — **first hit wins**:

1. `FUATILIA_TEST_PGBIN` — the Go lanes' override (e.g. `/usr/lib/postgresql/16/bin`);
2. `FUATILIA_PG_BIN_DIR` — the name the TS persistence testutil
   ([src/adapters/persistence/pg/testutil.ts](../src/adapters/persistence/pg/testutil.ts))
   and CI set;
3. `PATH` — the directory holding **both** `initdb` and `pg_ctl` (a distro
   install put on PATH works with zero configuration).

When nothing resolves, the run **fails** with an error naming every tried
path and the env vars that fix it (`backend-go/internal/infra/pgtest/pgtest.go`
`PGBin()` — see also `backend-go/README.md`).

**Boot the lane cluster** (trust auth on `127.0.0.1:5435` is the house
pattern — the migration runner `db/pgclient.cjs` speaks trust auth only by
design and refuses SASL/md5 loudly; see `db/README.md`):

```bash
# 1. initdb + start (adjust paths; PG16BIN is any directory holding initdb/pg_ctl)
PG16BIN=/usr/lib/postgresql/16/bin        # or brew --prefix postgresql@16/bin, or a portable install
$PG16BIN/initdb -D /tmp/fuatilia-pg -U postgres -A trust -E UTF8
$PG16BIN/pg_ctl -D /tmp/fuatilia-pg -o "-p 5435" -l /tmp/fuatilia-pg.log start

# 2. create the test databases
$PG16BIN/createdb -h 127.0.0.1 -p 5435 -U postgres fuatilia_pgadapters_test

# 3. apply the schema (forward-only runner; re-running is a verified no-op)
PGHOST=127.0.0.1 PGPORT=5435 PGUSER=postgres PGDATABASE=fuatilia_pgadapters_test \
  node db/migrate.cjs
```

A worked, idempotent version of this exact pattern ships in-repo:
`backend-go/internal/infra/testdata/boot-api-lane.sh` (provisions the
`fuatilia_api_test` lane database end-to-end; binary discovery mirrors
pgtest). The user-space pattern used by the maintainers — portable 16.4
binaries under `$HOME/tools`, no sudo, `db/validate.sh` finds them via
`PG_HOME` — is documented in `db/README.md`.

**Environment variables the test harness reads** (set by CI — see
`.github/workflows/ci.yml` and `go.yml` headers for the authoritative list):

| Variable | Read by | Default |
|---|---|---|
| `FUATILIA_TEST_DATABASE_URL` | TS PG-backed specs + Go suites | `postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test` |
| `FUATILIA_TEST_PGBIN` | Go pgtest (`pgtest.go` `EnvPGBin`) | — (falls through to `FUATILIA_PG_BIN_DIR`, then PATH) |
| `FUATILIA_PG_BIN_DIR` | TS ephemeral-cluster specs + Go pgtest | — |
| `FUATILIA_TEST_PGPORT` / `FUATILIA_TEST_PGDATA` | pgtest / boot script | `5435` / workspace default |
| `PGHOST PGPORT PGUSER PGDATABASE` | `db/migrate.cjs`, `db/exec.cjs`, `db/smoke.cjs` | — |

### 2.3 One-command verification

```bash
make gate          # typecheck (root+frontend) + vitest (root+frontend)
                   # + gofmt/go vet/go test -race (backend-go, real PG)
make validate      # static deploy validator (compose + env contract)
bash db/validate.sh            # throwaway cluster: migrate ×2 + 25 invariant assertions
python3 scripts/validate_openapi.py   # OpenAPI 3.1 contract vs route tables vs permission vocabulary
```

Full local stack (needs the Docker engine): `cp .env.example .env`, fill the
`CHANGE_ME` values (`openssl rand -hex 24`), then `make up` / `make smoke` /
`make down` ([DEPLOY.md](DEPLOY.md)).

---

## 3. Branch & PR contract

Every change follows the same loop — the contract the whole repository runs
on (root [README.md](../README.md) § "How we ship"):

1. **Issue first.** Every PR closes a tracked GitHub issue. The dispatch
   board of open work is [BACKLOG.md](BACKLOG.md). No issue → no PR.
2. **Branch off current `origin/main`.** Short-lived feature branches:
   `feat/<slug>` (multi-agent wave dispatch uses `w<wave>/<slug>`, e.g.
   `w11c/arch-contrib`). Never commit to `main`.
3. **Rebase before you open.** A PR found branched from a stale `main` gets
   rebased until the diff is pure change — stale-branch PRs have reverted
   merged work before; make the diff reviewable.
4. **Commit incrementally and push.** Each commit is gate-green and pushed;
   interrupted work survives (`git push -u origin <branch>`).
5. **PR body closes the issue**: `Closes #N` in the title or body — merging
   is what closes the issue, nothing else.
6. **Review then squash-merge.** Maintainer/orchestrator merges; **no
   self-merge**. Squash-merge only; branches auto-delete. A PR merges only
   when it is done, tested, verified and working — locally and in CI.
7. **CI status.** The workflows (`.github/workflows/ci.yml`, `go.yml`,
   `db.yml`) run the same gates on every push/PR. While the GitHub Actions
   account is under its billing lock ([docs/ops/CI-BILLING-BLOCKER.md](ops/CI-BILLING-BLOCKER.md)),
   **local green is the merge gate** — run `make gate` plus the lane
   checklists below before requesting review (see also
   [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md)).

---

## 4. Gate checklist per lane

Run what your diff touches; when unsure, run `make gate` (it runs the first
three). Everything must be green — there is no partial merge.

**TypeScript core (`src/`)**

```bash
npm run typecheck                                  # tsc --noEmit (strict)
FUATILIA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test \
  npm test                                         # vitest run — full suite
```

The PG-backed persistence specs **hard-require** the lane cluster and the
ephemeral-cluster specs (down/up/crash) hard-require real `initdb`/`pg_ctl`
(via `FUATILIA_PG_BIN_DIR` or PATH). Missing infrastructure fails the run —
there is no skip switch ([src/adapters/persistence/pg/testutil.ts](../src/adapters/persistence/pg/testutil.ts)).

**Frontend (`frontend/`)**

```bash
npm --prefix frontend run typecheck
npm --prefix frontend test        # vitest run (jsdom) — pure, no PostgreSQL
```

**Go (`backend-go/`)**

```bash
cd backend-go
gofmt -l .                                    # must print NOTHING
go vet ./...
FUATILIA_TEST_PGBIN=/usr/lib/postgresql/16/bin \
FUATILIA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test \
  go test ./... -race -count=1
```

- The integration suites boot **real PostgreSQL** (`pgtest`: shared lane
  cluster on 5435, or a private `initdb` cluster for restart-resilience
  tests). Unreachable PG or missing binaries **fails** — financial
  guarantees can only be evidenced against the real store.
- Apply migrations to the target database first (`node db/migrate.cjs` with
  the `PG*` variables — the outbox suite seeds/truncates the database
  directly and does not self-migrate; CI does this step, see `go.yml`).
- Running the outbox suite and the API-kernel suites side-by-side locally?
  Give each its own lane database (`fuatilia_test` / `fuatilia_api_test`) —
  parallel `TRUNCATE … CASCADE` on one shared database deadlocks
  (`backend-go/README.md` § integration tests).
- New in review: `govulncheck ./...` runs in `go.yml`.

**Database (`db/`)**

```bash
bash db/validate.sh     # throwaway cluster on :55432 → migrations in order
                        # → second pass is a no-op → 25/25 invariant assertions
```

Migration authoring rules (`db/README.md`):
forward-only — **never rewrite a shipped migration, append a new one**; one
file = one transaction (no BEGIN/COMMIT inside); `timestamptz`, BIGINT minor
units (never floats), composite org-scoped FKs; deterministic
`uq_/ck_/fk_/idx_/trg_` naming; invariant-ID comment on every constraint;
multi-row batch invariants are DEFERRABLE COMMIT triggers.

**Contract & deploy (when you touch the API, compose, or env)**

```bash
python3 scripts/validate_openapi.py   # spec validity + permission vocabulary + route-table consistency
python3 scripts/validate_deploy.py    # compose structure + .env.example contract
```

Any **new environment variable read** by compose, Go code, `db/*.cjs` or
frontend must get a `.env.example` key — the validator fails on drift in
either direction.

---

## 5. Test discipline

- **No skipped tests.** No `.skip`, no `t.Skip`, no conditional green.
  Suites that need infrastructure fail loudly when it is absent. If a test
  is wrong, fix or delete it in the same PR — never neuter it.
- **Fakes live in tests only.** Scripted transports, httptest servers, fake
  clocks, fixture corpora: all confined to `*.spec.ts` / `*_test.go`. The
  production modules are wired through ports (e.g. the webhooks worker's
  injected `Transport`/`SigningKeys`), so tests substitute at the seam —
  nothing in `src/` or `backend-go/` imports a fake.
- **Never weaken an assertion to make a suite pass.** Fixes strengthen or
  add cases; loosening an existing expectation to get green is a review
  rejection. When behavior changes deliberately, change the spec and the
  port together (see conformance below).
- **Table-driven by default.** Legal/illegal transition grids, boundary
  tables (±1 ms, ±1 minor unit), idempotency/replay suites, no-mutation
  pins, fake-clock determinism. New Go tests that mirror named TS scenarios
  follow the mapping-comment pattern of
  `backend-go/pkg/money/conformance_test.go`.
- **The domain stays pure.** `src/domain/**` has zero I/O: no DB, no clock,
  no RNG — time and randomness are injected (root `vitest.config.ts` runs
  the suite hermetically in seconds). If a change needs infrastructure, it
  belongs in an adapter, not the domain.
- **Money rules.** `bigint` minor units (TS) / `int64` (Go); floats banned
  from the money path; a single banker's-rounding point at the edge;
  allocation never creates or destroys a cent (R1/R2). The gate suite runs
  Go with `-race -count=1` and the whole TS suite on every merge.

---

## 6. Worked example: adding a `/v1` operation end-to-end

This is the path a new engineer follows, alone, from issue to merged PR.
Suppose the issue asks for `GET /v1/receivables/{id}/timeline`.

1. **Claim the issue** (§3) and branch: `git checkout -b feat/receivable-timeline origin/main`.
2. **Specify in the TS domain lane first** (ADR-0001). Add the pure function
   to the owning lane — e.g. `src/domain/receivables/` — with typed
   refusals (stable `SCREAMING_SNAKE` codes via
   `src/domain/shared/errors.ts`), injected clock, and a table-driven
   `*.spec.ts`. The lane's `README.md` states its contract; update it.
3. **Mount on the TS kernel.** Add a row to the owning route table —
   `src/adapters/http/routes/receivables.ts` — as
   `{ method, pattern, permission, handler }`. Handlers are **wire→lane
   adapters only**: they look up the aggregate, call the lane's pure math,
   project a JSON-safe view, and map `DomainError` codes through
   `src/adapters/http/kernel/errors.ts`. They never re-implement lane logic.
4. **Declare the contract.** Add the operation to
   [api/openapi/fuatilia.v1.yaml](../api/openapi/fuatilia.v1.yaml) with the
   envelope, error codes, and `x-required-permission` drawn from the closed
   vocabulary in `src/domain/auth/roles.ts`. Run
   `python3 scripts/validate_openapi.py` — it cross-checks spec ↔ permission
   vocabulary ↔ **all five** TS route tables in both directions.
5. **Schema, if the op needs new state.** Append
   `db/migrations/0015_your_change.sql` per the migration rules (§4).
   `bash db/validate.sh` must stay green (migrations in order, second pass
   idempotent, all 25 invariant assertions still fire).
6. **Port to Go.** Mirror the behavior:
   - route row in `backend-go/internal/transport/routes.go` (handler →
     service call → typed refusal);
   - command/query in `internal/application/` — the service owns the
     transaction boundary: state change + `appendOutbox` facts (+ ledger
     rows) commit **together**, and expected domain outcomes return
     `*infra.DomainError` with the same stable codes as TS;
   - persistence in `internal/repositories/` over the new migration;
   - **conformance tests** porting the TS scenarios with identical
     inputs/expected outputs (pattern: `backend-go/pkg/money/conformance_test.go`).
   The parity gate is mechanical: `internal/transport/parity_test.go` fails
   if the served (method, path) set and the OpenAPI operation set drift —
   including the pinned operation count. Update the pin **deliberately, in
   the same PR as the contract**.
7. **Wire the env contract.** Any new env read gets a `.env.example` key
   (§4) or `make validate` fails.
8. **Run the gates** (§4) for every lane you touched — TS core, Go, db,
   contract — plus frontend if the console consumes the new op (the typed
   client and fixtures live in `frontend/src/lib/api/`, pinned by
   `frontend/src/lib/api/contract.test.ts` against the same OpenAPI file).
9. **Commit conventionally** (§7) and push each green increment.
10. **Open the PR** with `Closes #N`, the gate evidence, and any doc updates
    (per-lane README, [BACKLOG.md](BACKLOG.md) status, an ADR in
    [DECISIONS.md](DECISIONS.md) if you decided something).

Steps 2–6 are the discipline in one sentence: **spec it pure, declare it in
the contract, persist it with invariants, port it under conformance** —
every layer cites the one above it.

---

## 7. Commit convention

Conventional Commits, scoped by lane:

```
<type>(<scope>): <imperative summary>

feat(webhooks): Go delivery worker — HMAC-signed at-least-once execution of the attempt ladder
fix(daraja): K1 wire parity — enforce TS DECIMAL_PATTERN on wire amounts
docs: ARCHITECTURE.md + CONTRIBUTING.md — the engineering handbook
chore(infra): pgtest binary discovery — fix broken default, align env names with TS+CI
build(deploy): full local compose stack — PG, NATS, backend-go, frontend + Makefile gate
ci: repair workflows — PG service wiring, version pins, manual dispatch
```

- `type`: `feat` `fix` `docs` `test` `refactor` `chore` `build` `ci`.
- `scope`: the lane or module (`web`, `payments`, `comms`, `daraja`,
  `webhooks`, `infra`, `deploy`, …).
- Imperative subject, no trailing period; the body says **why**; reference
  the issue (`Closes #N` lands in the PR, not the commit).
- One logical change per commit; every pushed commit passes its lane's gate.

---

## 8. Review expectations

A reviewer checks, in order:

1. **The contract**: issue linked, `Closes #N`, branch rebased, diff is pure
   change for its lane (lanes are file-disjoint by design — docs lanes don't
   touch code, code lanes don't touch docs).
2. **The gates**: the §4 checklists for every touched lane ran green
   locally; claims of "tests pass" come with the commands and counts.
3. **The discipline**: §1 ground rules, §5 test rules, no skipped/weakened
   tests, no secrets, no new env reads without `.env.example` keys, no
   TODO/FIXME.
4. **The parity**: TS behavior and Go port move together; the OpenAPI
   contract, route tables and the parity pin agree; schema changes carry
   invariant-ID comments and `db/validate.sh` green.
5. **The knowledge**: per-module `README.md` updated for behavior changes;
   user-facing docs (root `README.md` lanes table,
   [ARCHITECTURE.md](ARCHITECTURE.md)) updated when a surface changes;
   architectural decisions recorded as ADRs in
   [DECISIONS.md](DECISIONS.md) — link them, don't re-argue them in PRs.

Review is a dialogue on the diff; approval means *"I would put my name on
this running in production with real money"* — which is exactly what it will
do.

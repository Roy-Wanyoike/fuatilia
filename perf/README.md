# perf/ — k6 load harness for the mounted /v1 surface (issue #147)

A [k6](https://grafana.com/docs/k6/) harness that puts real load through the
Go `/v1` API and gates the run on **thresholds written as k6 thresholds** —
`p(95)` latency and error rate mapped to the roadmap's SLO *language*
(`docs/PRODUCT_ROADMAP.md` observability requirements; `docs/SPEC.md` §59
"Monitor" / §67 "Platform health metrics").

Nothing here is app code: `perf/**` is a load lane. The only credential in
the tree is the **local fixture ApiKey** the seed script prints — it
authenticates nothing outside a localhost trust-auth database. No real
secrets, no `.env` values, ever.

## Layout

```
perf/
├── lib/
│   ├── config.js       env-driven knobs (k6 v2: pass with -e, see below)
│   ├── thresholds.js   THE single source of threshold truth (SLO mapping)
│   ├── options.js      executor shape (closed-model constant-vus) + wiring
│   └── helpers.js      authed requests, envelope/contract checks, name tags
├── scenarios/
│   ├── smoke.js          1 VU × 10s  — pre-flight: up? migrated? creds valid?
│   ├── reads.js          10 VU × 2m  — authed read mix (lists+gets+ledger+feed)
│   └── payments-write.js  5 VU × 1m  — intake→confirm funnel + R9 replay leg
├── seed/
│   └── seed_perf.cjs   deterministic PG fixture (stdlib only, PRNG-seeded)
└── report/             REAL run output from local execution (see below)
```

## Surface exercised (all with the fixture ApiKey credential)

| Scenario | Operations | Mix |
|---|---|---|
| `reads` | `GET /v1/receivables` (+`/{id}`), `GET /v1/payments` (+`/{id}`), `GET /v1/collections/cases` (+`/{id}`), `GET /v1/ledger/accounts`, `GET /v1/ledger/entries`, `GET /v1/adjustments` | lists 40% · gets 25% · ledger 15% · adjustments 10% · cursor walk 10% |
| `payments-write` | `POST /v1/payments/intake`, `POST /v1/payments/{id}/confirmations` | intake→confirm 80% · R9 idempotent replay 12% · read-your-write 8% |
| `smoke` | `GET /v1/health`, `GET /v1/meta`, one authed read, one intake→confirm | 1 pass over each family per iteration |

Notes:
- `setup()` pages each list once to harvest **real ids** — a 404 would measure
  the error path, not the read path.
- The write scenario writes REAL payments + outbox facts (`perf-…` refs).
  Point it only at a disposable database (`fuatilia_perf`).
- Ledger and adjustments are list-only by contract (no get-by-id ops mounted).
- Every request carries a stable `name` tag (`GET /v1/receivables`, …) so a
  per-endpoint breakdown never explodes on path params.

## Thresholds → SLO language (edit ONLY `lib/thresholds.js`)

The roadmap names the quantities but sets **no numeric targets yet**
(`docs/PRODUCTION_AUDIT.md`: "no deployment exists to measure; the SPEC sets
no numeric SLOs"). Every number below is therefore a **harness-proposed
default**, chosen to be achievable by the as-shipped default stack (single Go
api process, pgxpool 10, local PostgreSQL 16) and flagged as proposed in the
code. They become SLOs when product ratifies them; the k6 exit code enforces
them either way — a breach fails the run loudly instead of drifting silently.

| k6 threshold | Default | SLO language it probes |
|---|---|---|
| `http_req_failed` `rate<0.01` | ≤ 1% errors | "Error rates" (SPEC §59) |
| `http_req_duration{scenario:reads}` `p(95)<300` | 300 ms | "API latency" (SPEC §59) |
| `http_req_duration{scenario:payments-write}` `p(95)<400` | 400 ms | "Webhook processing latency" (SPEC §67) — intake/confirmations ARE the Daraja callback surface |
| `checks` `rate>0.99` | ≥ 99% | "Payment success rate" surrogate (SPEC §59/§67) — envelope/contract checks; a fast wrong answer is still a breach |
| `http_req_duration{scenario:smoke}` `p(95)<1000` | 1000 ms | sanity only — never an SLO |

## How to run (exact commands)

### 0. Prerequisites
- Node ≥ 22 (the seed script is stdlib-only), the repo's `db/` tooling.
- A trust-auth PostgreSQL 16 cluster. This sandbox:
  `bash /home/z/my-project/scripts/boot_pg.sh` (port **5435**, user `postgres`).
  The compose stack works too (`make up`) — but then the api target is
  `http://127.0.0.1:8080` behind compose and the seed must run with
  compose's PG credentials (the migrate job inside compose does that part).
- k6 ≥ v2. **k6 v2 no longer forwards host environment variables into
  `__ENV`** — always pass knobs with `-e`. (`k6 inspect` is the parse check.)

### 1. Schema + seed (disposable database)

```bash
# fresh database with migrations 0001–0015 applied
createdb -h 127.0.0.1 -p 5435 -U postgres fuatilia_perf
PGUSER=postgres PGDATABASE=fuatilia_perf PGPORT=5435 node db/migrate.cjs

# deterministic fixture (TRUNCATEs orgs CASCADE first — idempotent)
PGUSER=postgres PGDATABASE=fuatilia_perf PGPORT=5435 node perf/seed/seed_perf.cjs
```

Default shape (scale 1, `PERF_SEED_SCALE=N` multiplies): 1 org · 3 users +
role/grants · **the harness ApiKey** (scopes: `receivables:read`,
`payments:read`, `payments:intake`, `payments:refund`, `collections:read`,
`collections:act`, `ledger:read`, `adjustments:request`) · 400 customers ·
6,000 receivables · 8,000 payments (realistic state mix) · 900 cases +
links + actions · 7-account chart + **20,000 balanced ledger lines** (every
entry Σdebit == Σcredit — the DEFERRABLE R4 trigger proves it at COMMIT) ·
400 R6-safe refunds + 400 credit notes.

The seed prints the harness credentials (FIXTURE-ONLY — they open nothing
outside a local trust-auth database; do not reuse elsewhere):

```bash
export PERF_API_KEY_ID=b147aaaa-0000-4000-8000-000000000001
export PERF_API_KEY_SECRET=perf-fixture-only-0000
# then pass them to k6 explicitly (k6 v2 does not forward host env):
K6_ARGS="-e PERF_API_KEY_ID=$PERF_API_KEY_ID -e PERF_API_KEY_SECRET=$PERF_API_KEY_SECRET"
```

### 2. Boot the api (two options)

```bash
# Option A — local Go binary (what the report below used)
cd backend-go && go build -o /tmp/fuatilia-api ./cmd/api && cd ..
DATABASE_URL='postgres://postgres@127.0.0.1:5435/fuatilia_perf?sslmode=disable' \
LISTEN_ADDR='127.0.0.1:8080' \
FUATILIA_RATE_LIMIT_RPM=0 \
/tmp/fuatilia-api

# Option B — the compose stack (measures containers + published port)
cp .env.example .env   # set POSTGRES_PASSWORD / DATABASE_URL, then:
make up                # api on http://127.0.0.1:8080
```

`FUATILIA_RATE_LIMIT_RPM=0` disables the token-bucket limiter (its default
300 rpm / 5 rps would throttle the run and make p(95) measure the limiter,
not the surface). Keep it enabled to test the limiter itself.

### 3. Run

```bash
K6=k6   # or the sandbox binary: /home/z/my-project/tools/k6/k6-v2.2.0-linux-amd64/k6

# parse check (issue #147 AC1) — prints the resolved options, runs nothing
$K6 inspect -e PERF_API_KEY_ID=… -e PERF_API_KEY_SECRET=… perf/scenarios/reads.js

# pre-flight, then the load scenarios (order matters: smoke first)
$K6 run -e PERF_API_KEY_ID=… -e PERF_API_KEY_SECRET=… perf/scenarios/smoke.js
$K6 run -e PERF_API_KEY_ID=… -e PERF_API_KEY_SECRET=… perf/scenarios/reads.js
$K6 run -e PERF_API_KEY_ID=… -e PERF_API_KEY_SECRET=… perf/scenarios/payments-write.js
```

Sizing knobs (all `-e`, defaults in `lib/config.js`): `PERF_BASE_URL`,
`PERF_READS_VUS` (10) / `PERF_READS_DURATION` (2m), `PERF_WRITE_VUS` (5) /
`PERF_WRITE_DURATION` (1m), `PERF_PAGE_SIZE` (50), `PERF_MAX_LIST_PAGES` (3),
`PERF_TIMEOUT` (10s), `PERF_ORG_SLUG` (perf-main).

### 4. Read the results

- **Exit code is the verdict.** `0` = every threshold held; non-zero
  (k6 `99`) = a threshold crossed — the summary names which.
- The `thresholds` block in `--summary-export` JSON carries the exact
  pass/fail per threshold (`"p(95)<300": true`).
- Per-endpoint breakdown: every request is tagged `name=GET /v1/…`;
  `k6 run --out json=run.json` emits per-tag samples you can aggregate, or
  promote any endpoint to a threshold by adding
  `http_req_duration{name:GET /v1/receivables}: ['p(95)<…']` in
  `lib/thresholds.js`.

## Run report — local execution, this sandbox (REAL numbers)

Environment (all local, reproducible with the commands above):
- k6 **v2.2.0** (`/home/z/my-project/tools/k6/k6-v2.2.0-linux-amd64`), local
  executor; raw output committed in `perf/report/*-run.log` +
  `*-summary.json` (`--summary-export`).
- api: single Go process built from this tree
  (`backend-go/cmd/api`, 27 mounted ops, log line `routes:27`), serving
  `127.0.0.1:8080`, pgxpool max_conns default 10, token-bucket limiter
  **disabled** (`FUATILIA_RATE_LIMIT_RPM=0`).
- PostgreSQL **16.4.0** lane cluster on `127.0.0.1:5435`
  (`scripts/boot_pg.sh`), database `fuatilia_perf` seeded exactly as above
  (scale 1).
- One fresh api process per scenario; nothing else ran concurrently.

Every threshold below was **held** (each run's exit code was `0`):

| Scenario | Duration | VUs | Requests | Throughput | http_req_failed | p(95) all | p(95) scenario | checks | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `smoke` | 10 s | 1 | 6,665 | 666 r/s | 0.00% (0) | **2.2 ms** | 2.2 ms | 100% | PASS |
| `reads` | 2 m | 10 | 49,249 | 410 r/s | 0.00% (0) | **159.3 ms** | 159.3 ms | 100% | PASS |
| `payments-write` | 1 m | 5 | 41,710 | 695 r/s | 0.00% (0) | **28.7 ms** | 28.7 ms | 100% | PASS |

Against the proposed ceilings: reads 159.3 ms ≤ 300 ms ✓, write path
28.7 ms ≤ 400 ms ✓, error rate 0 ≤ 1% ✓, contract checks 100% ≥ 99% ✓.

What the run writes: the write scenario is **not** idempotent against the
fixture (fresh `perf-<vu>-<iter>-<epoch>` external refs per iteration) — the
1-minute run above appended ~20k real payments + outbox facts to
`fuatilia_perf`, which is exactly why the seed is disposable-only. Re-seed
before claiming numbers again.

Honest caveats (read before quoting these numbers):
- **Localhost, single process, no TLS, limiter off** — this is a *harness
  baseline*, not a production SLO claim. The proposed thresholds become SLOs
  only when product ratifies them against a production-shaped deployment.
- The sandbox has **no Docker daemon** — Option B (compose) is documented
  but was not exercised here; `scripts/validate_deploy.py` statically covers
  the compose contract instead.
- Reads dominated the DB's page cache and the dataset (~40 MB) fits memory;
  treat absolute numbers as best-case until run against production-sized
  data (`PERF_SEED_SCALE`).
- The Go api was rebuilt from this tree mid-session when a stale
  pre-ledger-lane binary (27→22 ops) was found still bound to :8080 — ledger
  routes 404'd on it. Always confirm `/v1/meta` capabilities include
  `ledger` + `adjustments` before a run.

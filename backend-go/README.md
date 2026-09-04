# Fuatilia Go Backend — Foundation

The Go production core of Fuatilia. The TypeScript domain (`../../src/domain/`) is the
**behavioral specification**: every Go port mirrors its semantics, error codes and refusal
behavior one-for-one, and conformance tests prove parity with identical inputs and expected
outputs (see `pkg/money/conformance_test.go` for the scenario-to-scenario mapping).

Positioning and rationale: `docs/DECISIONS.md` ADR-0001, `docs/PRODUCT_ROADMAP.md` P0.

## Layout

```
backend-go/
├── go.mod                  # module github.com/Roy-Wanyoike/fuatilia/backend-go
├── cmd/
│   ├── api/main.go         # the /v1 API kernel binary — serves the 22-op mounted surface
│   │                       #   over PostgreSQL (issue #72). Config: DATABASE_URL (required),
│   │                       #   LISTEN_ADDR (default :8080). slog with requestId; secrets never logged.
│   └── worker/main.go      # the outbox relay binary (issue #74) — publishes committed
│                           #   outbox_events to NATS JetStream
├── internal/
│   ├── transport/          # stdlib net/http kernel: envelopes, error codes, cursor pagination,
│   │                       #   OpenAPI parity test (22 ops locked against api/openapi/fuatilia.v1.yaml)
│   ├── application/        # command services: payments intake (R9 funnel + ledger posting),
│   │                       #   receivables, collections (R8 exclusivity + per-org case sequence),
│   │                       #   auth admin; every fact appended to the outbox in the SAME tx
│   ├── repositories/       # pgx-backed stores over db/migrations 0001–0014, org_id on every row
│   ├── auth/               # session + ApiKey verification (bearer token IS the session id;
│   │                       #   `Authorization: ApiKey <id>.<secret>` split at the first dot),
│   │                       #   permission guard, fail-closed audited denials
│   ├── infra/              # config from env, pgx pool, envelope-v1 outbox append, slog, pgtest
│   └── outbox/             # the relay (issue #74): outbox_events → NATS JetStream with
│                           #   dedup, poison handling, replay
└── pkg/
    ├── money/              # exact money primitive — the port of src/domain/shared/money.ts
    │   ├── money.go        #   int64 minor units, closed ISO 4217 set, overflow-checked math
    │   ├── errors.go       #   stable SCREAMING_SNAKE codes + sentinels (errors.Is)
    │   ├── round.go        #   banker's rounding — the port of divideBankers
    │   ├── money_test.go   #   unit scenarios
    │   └── conformance_test.go  # TS parity suite: money.spec 8/8 + allocation R1/R2 13/15 + strategies pro-rata 8/8
    └── idempotency/        # R9/C5 first-write-wins registry — port of the semantics in
        └── registry.go     #   src/domain/payments/intake.ts + src/domain/events/outbox.ts
```

## Design rules (mirrored from the TS domain, docs/07-invariants.md)

- **Floats are banned from money.** Amounts are `int64` minor units. The only float ever
  accepted is an allocation *weight*, scaled to an exact rational at `1e9` precision —
  bit-identical to the TS `BigInt(Math.round(w * 1e9))` scaling.
- **Money is never negative.** Postings carry direction in the ledger (later wave);
  a negative amount is always a modelling bug and is refused (`MONEY_NEGATIVE`).
- **No cent created or destroyed (R1/R2).** `Allocate` is largest-remainder with a
  deterministic tie-break (larger remainder first, then smaller index); the parts always
  sum exactly to the original.
- **Single rounding point.** Fee/FX pipelines round exactly once via
  `RoundBankers` / `MulDivBankers` (exact halves to even), matching the TS `divideBankers`.
- **Errors are values.** Every failure is a typed `*Error` with a stable machine code;
  match with `errors.Is(err, money.ErrUnderflow)` or by code.

## Idempotency semantics (R9/C5)

`pkg/idempotency` pins the registry contract a durable store (PostgreSQL unique index on
`(scope, key)`) must reproduce: first-write-wins per `(scope, key)`; replays return the
ORIGINAL outcome with `Replayed=true`; a failed execution claims nothing so retries stay
legitimate; `Put` is the outbox-style put-if-absent primitive
(`IDEMPOTENCY_KEY_TAKEN`, the `OUTBOX_DUPLICATE` twin). The concurrency model
(single critical section, deterministic double-submit winner) is documented in the
package doc comment, including the two caller obligations (no reentrant calls; keep `fn` short).

## Verification

```sh
gofmt -l .        # must print nothing
go vet ./...
go test ./... -race
```

### Integration tests boot REAL PostgreSQL (no stubs, no silent skips)

The transport, auth, infra and outbox suites run against a real PostgreSQL 16 with
`db/migrations/0001–0014` applied. An unreachable PG **fails** the run — it is never
silently skipped (financial guarantees can only be evidenced against the real store).

**Per-lane databases are load-bearing:** `go test ./...` runs packages in parallel, and
parallel `TRUNCATE ... CASCADE` on one shared database deadlocks. Each lane therefore
targets its own database via `FUATILIA_TEST_DATABASE_URL` (default
`postgres://postgres@127.0.0.1:5435/fuatilia_test`):

```sh
# boot a cluster once (any PG 16), then:
#   lane DB fuatilia_test        ← internal/outbox (relay)
#   lane DB fuatilia_api_test    ← transport + auth + infra + application (API kernel)
node db/migrate.cjs --user postgres --db fuatilia_api_test   # apply migrations per lane DB

export PATH="$HOME/tools/go/bin:$PATH"
FUATILIA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5435/fuatilia_test \
  go test -race ./internal/outbox/
FUATILIA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5435/fuatilia_api_test \
  go test -race $(go list ./... | grep -v internal/outbox)
```

CI (`.github/workflows/go.yml`) runs the same gates on every push/PR; it activates
once the GitHub account billing lock is resolved — until then local green is the merge gate
(see `docs/ENGINEERING_STATUS.md`).

## What this module deliberately does NOT contain yet

No broker publishing from the request path (the transactional outbox plus the relay is the
publish path — ADR-0003), no Temporal workflows, no Daraja HTTP client: later waves add
them (roadmap P1 in `docs/PRODUCT_ROADMAP.md`). The TS code in `src/` remains the
behavioral specification: every Go handler cites and mirrors its lane.

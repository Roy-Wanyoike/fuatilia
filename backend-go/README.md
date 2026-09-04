# Fuatilia Go Backend — Foundation

The Go production core of Fuatilia. The TypeScript domain (`../../src/domain/`) is the
**behavioral specification**: every Go port mirrors its semantics, error codes and refusal
behavior one-for-one, and conformance tests prove parity with identical inputs and expected
outputs (see `pkg/money/conformance_test.go` for the scenario-to-scenario mapping).

Positioning and rationale: `docs/DECISIONS.md` ADR-0001, `docs/PRODUCT_ROADMAP.md` P0.

## Layout

```
backend-go/
├── go.mod                  # module github.com/Roy-Wanyoike/fuatilia/backend-go (Go 1.23)
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
export PATH="$HOME/tools/go/bin:$PATH"   # local toolchain (CI uses setup-go 1.23)
gofmt -l .        # must print nothing
go vet ./...
go test ./... -race
```

CI (`.github/workflows/go.yml`) runs the same three gates on every push/PR; it activates
once the GitHub account billing lock is resolved — until then local green is the merge gate
(see `docs/ENGINEERING_STATUS.md`).

## What this module deliberately does NOT contain yet

No `cmd/`, no HTTP transport, no storage: later waves mount the `/v1` API over these
primitives (roadmap P0 → P1 in `docs/PRODUCT_ROADMAP.md`). New packages must keep zero
third-party dependencies and the parity contract against the TS specification.

# internal/webhooks — the Go delivery worker (issue #91)

Executes the pure attempt ladder (`src/domain/webhooks/attempts.ts`, schema
`db/migrations/0012_webhooks.sql`) against PostgreSQL with HMAC-SHA256 signed
HTTP POSTs whose wire contract is the one pinned by
`src/domain/webhooks/signing.ts` (`t=<unixMillis>,v1=<lowercase hex>` over
`<unixMillis>.<payload>`).

```
webhook_deliveries (queued | failed-with-retries, due per next_attempt_at)
        ↓  CLAIM — one short tx: SELECT … FOR UPDATE SKIP LOCKED
        ↓  state → delivering, commit — row locks released BEFORE any I/O
        ↓  resolve secret via the SigningKeys port (schema stores hashes only)
        ↓  sign the canonical envelope, POST via the INJECTED Transport
        ↓  (network I/O strictly OUTSIDE any transaction)
        ↓  RECORD — one tx: attempt record + ladder advance together
queued+next_attempt_at ←failure (retries left) — success → delivered
                            └ exhaustion → dead_lettered (terminal, frozen)
```

## Delivery guarantees

| Guarantee | Mechanism | Proof |
|---|---|---|
| At-least-once | claim-then-post-then-record: a crash between POST and record leaves the row `delivering` until the claim lease (`updated_at`-stamped) expires, then the next claim redelivers it; receivers dedupe by event id (`aggregateId` of the signed envelope) | `TestCrashBetweenPostAndRecordRedeliversOnRestart`, `TestClaimDueLeaseRecoveryIsTheAtLeastOncePath` |
| No double-claim across workers | `FOR UPDATE OF d SKIP LOCKED` claims; two workers racing on the same delivery never both win it | `TestConcurrentWorkersNeverDoubleClaim` (4 workers, receiver counts exactly one POST per event) |
| Ladder parity | `willRetry = attemptNo <= len(ladder)`, `nextAttemptAt = now + ladder[attemptNo-1]` (pure port in `attempts.go`); success / 4xx / 5xx / network errors walk the identical schedule; exhaustion → `dead_lettered` terminal | `TestWorkerWalksTheLadderAgainstPostgreSQL`, `TestNetworkErrorsWalkTheSameLadder`, `TestRecordOutcome*` (pure half) |
| Record + advance atomicity | `RecordFailure` writes `attempt_count`/`last_error` AND `state`/`next_attempt_at`/`dead_lettered_at` in ONE transaction, guarded by `state = 'delivering'` under the row lock; lost claims discard their outcome (exactly one record lands) | `TestRecordFailureWritesRecordAndLadderAdvanceTogether` |
| Signature parity | canonical string `<unixMillis>.<payload>`, header `t=<unixMillis>,v1=<lowercase hex>`, stdlib HMAC-SHA256; the TS spec's vectors are ported 1:1 in `signing_test.go` (parser table, MALFORMED → STALE_TIMESTAMP → MISMATCH with inclusive ±skew, replay ledger) | `signing_test.go`, wire check in `TestWorkerDeliversSignedEnvelopeAndStampsDelivered` (the bytes on the wire verify under the pinned decision table) |
| Envelope fidelity | the payload jsonb text is appended BYTE FOR BYTE (no re-encoding, no key reordering) — every attempt of a delivery signs byte-identical bytes | `TestWorkerDeliversSignedEnvelopeAndStampsDelivered`, `TestWorkerWalksTheLadderAgainstPostgreSQL` |
| Revoked/disabled endpoints never deliver | the claim query joins `webhook_endpoints` ON `e.active`; inactive endpoints' rows simply wait | `TestInactiveEndpointsAreNeverDelivered` |

## State mapping (pure model ↔ SQL enum)

`webhook_state` = `queued | delivering | delivered | failed | dead_lettered`.
The TS aggregate's retry-pending state (`failure with retries left → queued +
nextAttemptAt`) persists as **`failed` + `next_attempt_at`** — the enum has no
separate retry-pending name, and `idx_webhook_deliveries_due` covers exactly
`('queued','failed')`. The schedule itself comes from the shared pure
functions (`WillRetry` / `BackoffFor`), so parity is by construction.
Terminal rows (`delivered` / `dead_lettered`) are frozen by the schema trigger
(0012); the `state = 'delivering'` predicate on every record statement keeps
this worker from ever touching them.

## Secrets (env-backed today, KMS-ready)

0012 stores endpoint secrets HASHED (`secret_hash` / `secret_prefix` are
identification references, never plaintext). The worker resolves signing keys
through the injected `SigningKeys` port (`SecretFor(ctx, orgID, endpointID)`):

- **Production default (issue #177): `EnvSigningKeys`** (`keys.go`) parses the
  deployment's `WEBHOOK_SIGNING_SECRETS` — entries of
  `<orgUUID>:<endpointUUID>:<secret>` separated by commas or newlines,
  validated at boot (malformed → `WEBHOOK_CONFIG_INVALID`, the worker refuses
  to start; errors never echo secret material). Rotation: update the env and
  rolling-restart between delivery windows — receivers honoring the ±5 min
  skew window tolerate the cutover (docs/security/secrets.md §4).
- **KMS drop-in:** an adapter implementing the same one-method port swaps in
  at the `cmd/worker` wiring site; nothing in this package changes.

Nothing in this package can read a plaintext secret from the database, and
secret material never appears in logs or errors.

## Process surface (issue #177)

`cmd/worker` — the compose `worker` service target — boots the loop alongside
the outbox relay when `WEBHOOKS_ENABLED=1`, and refuses to boot enabled
without usable `WEBHOOK_SIGNING_SECRETS` (fail closed). The event source is
PostgreSQL itself: the claim needs the row's transactional state machine
(claim → `delivering` → record, `SKIP LOCKED` across replicas), so the loop
consumes the table directly and deliberately does NOT ride NATS — the outbox
relay publishes the same domain events downstream for other consumers.
SIGTERM stops claiming, the in-flight delivery completes (context detached
from the run context, bounded by `DeliveryTimeout`), its outcome is recorded,
and the process exits 0. Integration evidence: `cmd/worker/main_test.go`
(claims a queued delivery on real PostgreSQL, signs with the env-resolved
key, delivers via the injected Transport port, drains on cancellation; the
compiled binary boots against a real cluster and exits 0 on SIGTERM).

## Config (Config / ResolveConfig)

| Field | Default | Meaning |
|---|---|---|
| `PollInterval` | 1s | idle wait between empty cycles |
| `DeliveryTimeout` | 15s | bounds one POST (and the in-flight completion after SIGTERM) |
| `ClaimLease` | 2m | how long a `delivering` claim is honored before a peer may steal it (must be ≥ `DeliveryTimeout`) |
| `Ladder` | ~30s/2m/10m/30m/2h/6h | `attempts.ts DEFAULT_RETRY_LADDER_MS` |
| `Clock` | system | injected time port (deterministic tests inject fixed/stepping clocks) |

Graceful shutdown: `Run` observes the context — cancellation stops claiming,
the in-flight delivery completes or times out on a context detached from the
run context, its outcome is recorded, and the worker exits nil.

## Tests

Pure table tests port the TS spec vectors (`signing_test.go`,
`attempts_test.go`, `worker_test.go`); the integration evidence boots a
PRIVATE PostgreSQL 16.4 cluster through `internal/infra/pgtest.StartTemp`
(migrations 0001–0014, no skip switch — unreachable PostgreSQL fails the run)
and drives real workers against real receivers (`store_test.go`). Run:

```
FUATILIA_TEST_PGBIN=<portable pg16.4 bin> go test ./internal/webhooks/ -race
```

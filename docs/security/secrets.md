# Secret-management runbook (issue #143)

Status: living document. Companion to the [threat model](./threat-model.md)
(boundary-by-boundary STRIDE). This file is the OPERATOR-facing contract for
how secrets are stored, rotated, leaked-against, and gated in CI.

Baseline commit for every cited path: `5280e0a` (main, wave-11).

---

## 1. Principles (non-negotiable)

1. **Env or KMS — never files, never code, never logs.** The only sanctioned
   secret stores are (a) the process environment supplied by the deployment
   (docker-compose env interpolation, orchestrator secret manager) and (b),
   once bound, the KMS behind the `SigningKeys` port (§4). No secret may
   appear in a committed file, a test fixture, a log line, an error envelope,
   or a URL.
2. **The database stores verifiers, not secrets.** API-key and webhook-endpoint
   secrets are persisted as hashes + identification prefixes only
   (`backend-go/internal/repositories/authstore.go`,
   `db/migrations/0012_webhooks.sql`). Plaintext is shown exactly once, at
   creation, and never persisted.
3. **No default credentials exist.** `.env.example` carries `CHANGE_ME`
   placeholders only; this is enforced mechanically
   (`scripts/validate_deploy.py` refuses `POSTGRES_PASSWORD`/`DATABASE_URL`
   values without `CHANGE_ME`). Generate real values with
   `openssl rand -hex 24` (24 bytes = 48 hex chars).
4. **Tests use fakes, never real credentials.** Daraja traffic is exercised
   against scriptable `httptest` fakes with fake clocks/sleepers
   (`backend-go/internal/daraja/fake_test.go`,
   `backend-go/internal/daraja/README.md` §"Tests never touch network"); any
   credential-shaped string in a `*_test.go` / `*.spec.ts` file is fake by
   construction (`sandbox-key-000000`-style).
5. **Git history is not a purge mechanism.** A secret that reaches a commit is
   compromised the moment it is pushed; the response is rotation (§5), not
   history editing. History rewriting may accompany rotation for hygiene but
   NEVER replaces it.

---

## 2. Secret inventory (who consumes what, where)

| Secret | Consumed by (verified path) | Storage | Class |
|---|---|---|---|
| `POSTGRES_PASSWORD` / `DATABASE_URL` | `backend-go/internal/infra/config.go` (`LoadConfig`), `backend-go/cmd/worker/main.go`, `db/migrate.cjs` tooling | env only; compose interpolation | Infra credential |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` | `backend-go/internal/daraja/client.go` (`ConfigFromEnv` — refuses to boot without them) | env only; "never hardcoded, never logged" (`backend-go/internal/daraja/README.md`) | Provider credential |
| B2C passkeys / `SecurityCredential` / initiator names | Per-call inputs injected by the service layer from its own secret source (`backend-go/internal/daraja/README.md`) | service-injected; never literals, never logs | Provider credential |
| `ETIMS_VSDC_CMC_KEY` (+ `ETIMS_TIN`, `ETIMS_BRANCH_ID`, `ETIMS_DEVICE_SERIAL`) | `src/adapters/etims/config.ts` (TS lane spec; missing credentials throw stable `ETIMS_CONFIG_INVALID` — the lane never starts) | env only | Provider credential |
| Webhook endpoint signing secrets | `backend-go/internal/webhooks/worker.go` (`SigningKeys.SecretFor` port); persisted shape is `secret_hash`/`secret_prefix` only (`db/migrations/0012_webhooks.sql`) | hash in DB + plaintext via env/KMS port | Customer-facing signing key |
| API-key secrets (`ApiKey <id>.<secret>`) | `backend-go/internal/repositories/authstore.go` (SHA-256 verify, constant-time: `backend-go/internal/auth/codec.go`) | hash + prefix in DB; plaintext once at creation | Customer-facing credential |
| Session tokens (dashboard `fuatilia_session`, portal `fuatilia_portal_session`) | `frontend/src/lib/auth/session.ts`, `frontend/src/lib/portal/session.ts`; validated against the live auth store server-side | httpOnly cookie only (8 h upper bound); never localStorage/URL | Runtime credential |
| `NATS_URL` | `backend-go/cmd/worker/main.go` | env; currently unauthenticated on the compose-internal network — if you add NATS auth, its credential lands in this table | Infra endpoint |

Anything read from the environment by compose, Go, db tooling, or the
frontend MUST have a `.env.example` key — enforced in both directions by the
validator (`scripts/validate_deploy.py` "no drift" gate), so this inventory
cannot rot silently: a new secret read without an example key fails the
static gate.

---

## 3. Storage rules (the env/KMS rule, precisely)

- **Committed files:** `.env.example` only, placeholders only. `.env` is
  gitignored (`.gitignore`: `.env`, `.env.*`) — real values live there for
  local runs and are never staged. Review rule: any `rg`-able
  credential-shaped literal outside `CHANGE_ME` fixtures in `.env.example`
  is a blocker.
- **Logs:** structured logging carries a redaction guard — any key whose
  lowercased name contains `authorization`, `password`, `token`, `secret` or
  `credential` is redacted, groups whose children are all redacted
  disappear (`backend-go/internal/observability/logging.go`
  `forbiddenFragments`, `NewRedactedLogger`). Redaction is always on; it is
  not config-gated.
- **Errors:** the kernel never carries internals to the wire — unmapped
  errors go to the `OnError` sink and the response body stays generic
  (`backend-go/internal/transport/kernel.go` `KernelOptions.OnError`); the
  BFF/portal routes fail closed with contract envelopes, cause logged not
  leaked (`frontend/src/app/(portal)/api/portal/v1/[...path]/route.ts`).
- **The database:** verifiers only (inventory rows above). If you are
  designing a new credentialed surface, follow the api_keys/webhooks
  pattern: hash + identification prefix in the schema, plaintext shown once,
  resolution through a port.
- **KMS port — the drop-in seam.** `backend-go/internal/webhooks/worker.go`
  defines `SigningKeys` (`SecretFor(ctx, orgID, endpointID)`) explicitly as
  the seam "a KMS adapter is the production drop-in" — the schema stores only
  hashes, so nothing in the worker can ever read plaintext from the
  database. New secret-resolution code should grow the same kind of port
  rather than reaching for files. The digest itself is injected too
  (`DigestPort`, `backend-go/internal/webhooks/signing.go`), which keeps
  secret material out of test fixtures.

---

## 4. Rotation cadence

Rotate on schedule AND on trigger. Scheduled cadence (default policy — tune
per customer contract):

| Secret | Cadence | Procedure |
|---|---|---|
| `POSTGRES_PASSWORD` / `DATABASE_URL` | 90 days, or immediately on staff change with env access | Generate `openssl rand -hex 24`; update the orchestrator env; rolling-restart api + worker; verify `/v1/health` and the worker's DB probe. Compose note: `DATABASE_URL` must agree with `POSTGRES_PASSWORD` (`.env.example` header contract). |
| `DARAJA_CONSUMER_KEY`/`_SECRET` | 90 days, or on any `auth`-kind Daraja error (the taxonomy's operator reflex is "alert, re-provision secrets": `backend-go/internal/daraja/README.md`) | Re-issue in the Safaricom Daraja portal → update env → rolling-restart api. The OAuth layer re-auths on 401 (single-flight refresh: `backend-go/internal/daraja/oauth.go`) — but a revoked app credential still needs the env update. |
| `ETIMS_VSDC_CMC_KEY` | Per KRA/VSDC device policy, or on device re-registration | Update via the orchestrator env; the lane refuses to start on missing config (`src/adapters/etims/config.ts`) so a typo fails loudly, not silently. |
| Webhook endpoint signing secrets | 180 days default, or immediately on customer request / leak suspicion | Re-issue: new plaintext shown ONCE at creation (the same discipline as api_keys — `db/migrations/0012_webhooks.sql` header), update the customer's receiver config, update the hash/prefix row. In-flight deliveries: rotate between delivery windows; receivers honoring the ±5 min skew window tolerate the cutover. |
| API keys | On demand (owner-scoped, revocable) | Issue with minimal concrete scopes + an explicit expiry (`backend-go/internal/application/authadmin.go` `AUTH_KEY_SCOPES_REQUIRED`, `AUTH_KEY_EXPIRY_INVALID`); revoke via the admin route; the owner's status cascades (`backend-go/internal/auth/guard.go` `Principal.UserID`). |
| Session tokens | Not operator-rotated — bounded (8 h cookie upper bound) + upstream idle/absolute expiry + revocation | Revoke via `POST /v1/auth/sessions/revocations` (mandatory reason); portal sign-out expires the cookie server-side (`frontend/src/lib/portal/session-route.ts` `DELETE`). |

Triggered rotation (override the schedule — rotate NOW) whenever: a secret
appears in a commit, a log line, an issue/PR body, or a URL; a laptop/CI
runner with env access is lost or compromised; a provider confirms key
exposure; an anomaly on the audited-denial trail suggests credential testing
(`backend-go/internal/infra/audit.go` chain).

---

## 5. Leak response (incident runbook)

Ordered; do not skip to cleanup — **rotation first, forensics second,
cleanup third.**

1. **Contain — revoke/rotate the exposed secret.**
   - Committed credential (`POSTGRES_PASSWORD`, Daraja keys, …): rotate at
     the source, update env, rolling-restart. A secret in a pushed commit is
     burned even if the commit is amended seconds later.
   - Leaked webhook endpoint secret: re-issue the endpoint secret (§4) —
     old signatures stop verifying on the receiver once rotated.
   - Leaked API key: revoke via the admin surface (status change cascades
     immediately — `backend-go/internal/auth/guard.go` status check).
   - Leaked session token: `POST /v1/auth/sessions/revocations`.
2. **Verify blast radius on the audit chain.** The tamper-evident per-org
   `audit_events` chain is the source of truth for what the exposed
   credential DID: every auth denial and consequential operation is on it
   (`backend-go/internal/infra/audit.go`,
   `db/migrations/0013_audit_outbox.sql`). Look for: denials from unknown
   principals around the exposure window, money-kind refusals
   (`DARAJA_DUPLICATE_AMOUNT_MISMATCH` → possible tamper probing:
   `backend-go/internal/daraja/intake.go`), escalation attempts
   (`auth.escalationBlocked`).
3. **Assess money impact with the money-kind taxonomy.** Any `auth`-kind or
   `money`-kind error storm is the README's defined "alert finance / alert +
   re-provision" reflex (`backend-go/internal/daraja/README.md`,
   `backend-go/internal/daraja/errors.go`).
4. **Purge the artifact (after rotation).** Remove the secret from the tree
   in a fix commit; decide on history rewrite with the repo owner (rotation
   already made history harmless; rewriting is hygiene for secret-scanners,
   not containment). Never paste the exposed value into the incident
   document — reference it by fingerprint (first 4 + last 4 chars) only.
5. **Report.** Open an issue tagged `security` (no secret material in the
   body), notify affected customers if a customer-facing secret (webhook /
   API key) was exposed, record the timeline against the audit chain
   timestamps.
6. **Harden.** Every leak response ends with a control change: the validator
   gate, a redaction fragment, a new CHECK constraint, or a runbook edit.
   State the change in the issue.

---

## 6. CI policy

- **The static deployment gate enforces the env contract + placeholder
  discipline.** `scripts/validate_deploy.py` proves: every env var referenced
  by compose / read from Go / read by db tooling / read by the frontend has a
  committed `.env.example` key (no drift in either direction), and
  `POSTGRES_PASSWORD` + `DATABASE_URL` in `.env.example` are `CHANGE_ME`
  placeholders — "no committed credential default".
- **No credentials in CI logs or artifacts.** Workflows
  (`.github/workflows/ci.yml`, `go.yml`, `db.yml`) consume no provider
  secrets; test suites run against ephemeral local clusters
  (`FUATILIA_TEST_DATABASE_URL` placeholders, PG binaries from the runner)
  and Go/TS fakes. Operator `gh`/git credentials live in the runner's
  config, never in repo files or workflow YAML.
- **No real credentials anywhere in the tree.** Examples in docs and
  fixtures are clearly fake (`CHANGE_ME__…`, `sandbox-key-000000`,
  `ws_CO_demo123456`-style). Anything that looks like live base64/hex
  credential material in a fixture is a review blocker.
- **Known gap (honest):** there is no automated secret scanner (gitleaks /
  trufflehog) in CI yet. Compensating controls today: the validator's
  placeholder gates, the redaction-always-on logger, and review discipline
  ("no credential-shaped literals outside `.env.example` placeholders").
  Follow-up: add a scanner job to `.github/workflows/ci.yml` with an
  allowlist for the `CHANGE_ME` fixtures — tracked from the threat model's
  residual-risk register (§8 item 8).

---

## 7. Quick reference — fake vs real

| Looks like | Real? | Where it may appear |
|---|---|---|
| `CHANGE_ME__RUN_openssl_rand_hex_24` | never | `.env.example` only |
| `openssl rand -hex 24` output | yes | env/orchestrator only — NEVER a file |
| `sandbox-key-000000` / `fake-consumer-secret` | never | tests, fixtures, docs |
| `ws_CO_demo123456`, `2547XXXXXXXX`-shaped fixtures | never | test vectors (`backend-go/internal/daraja/fixtures_test.go`, TS `*.spec.ts`) |
| Session UUIDs (`00000000-0000-4000-8000-…`) | never | docs/examples (the auth lane's nil-org sentinel shape) |

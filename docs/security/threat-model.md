# Fuatilia threat model — STRIDE per boundary (issue #143)

Status: living document. Baseline commit for every cited path: `5280e0a`
(main, wave-11). The mitigation column cites ONLY paths verified to exist in
the tree at that commit; a path that stops existing makes this document
wrong, so each cited path is re-checked on every revision of this file.

Related: [secrets runbook](./secrets.md) (storage rules, rotation, leak
response, CI policy) · `docs/PRODUCTION_AUDIT.md` (§5.2 rate limiting +
headers) · `docs/SPEC.md` (§35 permissions, §37 audit, §38 envelopes) ·
`docs/ARCHITECTURE.md` (composition).

---

## 1. Scope, method, trust boundaries

Method: per trust boundary, enumerate the threats (STRIDE class), map each
to the mitigating code (verified paths), and state the residual risk that
**remains after** the mitigation. We deliberately do not claim transport-level
guarantees Safaricom Daraja does not give us (callbacks are not signed by the
provider) — residual risks are written honestly, not wished away.

Trust boundaries (who is on the far side of the arrow):

```
 [Safaricom Daraja]  ──callbacks──▶  ┌───────────────────────────┐
                                     │  B1  Daraja callback edge │
 [Webhook receivers] ◀──signed POST─ │  B2  Webhook delivery     │
                                     │                           │
 [Payer browsers]    ──portal/BFF──▶ │  B3  Portal tokenization  │
 [Operator browsers] ──dashboard───▶ │  B4  AuthN/AuthZ + org    │
                                     │      isolation (Go API)   │
 [Anonymous internet] ──/v1/health─▶ │  B5  Rate limit/headers   │
                                     │                           │
 [Org admins]        ──/v1/auth/*──▶ │  B6  Admin surface        │
                                     └───────────────────────────┘
                                               │
                                     [PostgreSQL truth store]
```

Cross-cutting control: every consequential operation — including every auth
denial and escalation refusal — lands on the tamper-evident, per-org
hash-chained `audit_events` ledger
(`backend-go/internal/infra/audit.go`, `db/migrations/0013_audit_outbox.sql`).
Denials are facts (SPEC §37), which is what makes the repudiation column of
every boundary below short.

---

## 2. B1 — Daraja callbacks (money-adjacent untrusted input)

Far side: Safaricom's M-Pesa callback endpoints (C2B validation /
confirmation, STK result, B2C result) and anything impersonating them.
Hard truth stated up front: **Daraja does not cryptographically sign its
callbacks**, so spoof resistance here is structural (wire-shape refusals)
plus economic (journey-ledger idempotency + initiation binding), never
transport auth. Everything else in this boundary is designed around that.

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| D1 | Forged / spoofed callback invents money | Spoofing, Tampering | The K1 untrusted-input boundary parses every payload as hostile evidence and refuses anything structurally wrong with a stable `DARAJA_*` code — nothing guessed, defaulted or coerced: wire patterns `TransID ^[A-Z0-9]{10,22}$`, `CheckoutRequestID ^ws_CO_[A-Za-z0-9]{6,24}$`, MSISDN `254[17]\d{8}`, short code `\d{5,7}` (`backend-go/internal/daraja/callbacks.go`; TS spec `src/adapters/daraja/wire.ts`). Structurally-bad payloads are dead-lettered by the transport, never retried into the domain. | No transport-auth on Daraja callbacks exists in the provider contract. A well-shaped forged callback (valid TransID shape, fresh journey key) can still be *accepted as evidence* — it cannot invent money that disagrees with a merchant-initiated amount (D4/D5) or replay an existing journey (D2), but a wholly fabricated journey key with no initiation record is accepted for C2B confirmation. Mitigations beyond this boundary: bank-statement reconciliation cross-checks (PesaLink adapter lane, `src/adapters/bankfeed/feeds.ts`), finance alerting on money-kind refusals (`backend-go/internal/daraja/errors.go` kind taxonomy). |
| D2 | Callback replay — same delivery redelivered by Daraja's at-least-once pipes (or an attacker) | Spoofing (freshness), Repudiation | R9 intake funnel: `IntakeCallback` claims each money-journey once through an **atomic** `ClaimJourney` (unique-constraint semantics; concurrent deliveries produce exactly one winner): first sight → `accepted`; same journey + same money → `duplicate` (same result as the first delivery, downstream never re-runs, `OnDuplicate` tripwire fires once) (`backend-go/internal/daraja/intake.go`). Journey keys: `c2b:<TransID>`, `stk:<CheckoutRequestID>`, `b2c:<TransactionID>` (same vocabulary as the TS simulator). General idempotency-registry discipline: `backend-go/pkg/idempotency/registry.go`. | The ledger must be durable. The injected `JourneyLedger` port is satisfied by an in-memory `MemLedger` for tests only — production MUST bind the PostgreSQL-backed store; a fleet of API replicas needs the ledger to be shared, not per-process. |
| D3 | Ledger outage turns a replay into fresh money | Denial of service, Tampering | Fail-closed ledger: if `ClaimJourney` errors, the callback is `rejected` with `DARAJA_LEDGER_UNAVAILABLE` (network-kind) — an unreadable ledger never lets a replayed callback masquerade as fresh; at-least-once redelivery retries later (`backend-go/internal/daraja/intake.go`, header comment "Ledger errors are NEVER swallowed"). | Availability, not integrity: a ledger outage stalls intake (correct behavior — a wrong verdict here invents or destroys money). Operational consequence: alert on `DARAJA_LEDGER_UNAVAILABLE` as page-worthy. |
| D4 | Same journey replayed with **different money** (tampered amount) | Tampering | Same journey + different amount is classified as tampering, not retry: `rejected` with `DARAJA_DUPLICATE_AMOUNT_MISMATCH` (money-kind → alert finance, dead-letter), enforced on exact minor units (`backend-go/internal/daraja/intake.go`; parity with the payments lane's `assertDuplicateMoney`). | None known beyond D1's C2B-confirmation caveat (a fabricated *fresh* journey is not a mismatch — there is no prior amount to disagree with). |
| D5 | STK result claims an amount the merchant never initiated | Tampering, Elevation of privilege | Failure results carry NO amount on the wire; the intake amount is backed by the merchant's own initiation record (`E11` `STKRequested` map of `CheckoutRequestID` → requested minor units) and the parse refuses without it (`DARAJA_STK_AMOUNT_UNKNOWN`). Success metadata must agree exactly with the initiated amount or the callback is refused as tampered (`backend-go/internal/daraja/callbacks.go` `ParseOptions.STKRequested`; `backend-go/internal/daraja/money.go` decimal-string → integer minor units, never floats; `src/domain/collections/stk/actions.ts` `reconcileStkCallback` — byte-identical journey key `daraja:stk:<checkoutRequestId>`). | Initiation records live in the same PostgreSQL truth store; an attacker with write access there is outside this model (B4 boundary + secrets runbook §3). |
| D6 | Unknown STK result code mapped to money | Tampering | Unknown result codes fail closed: only `0` completes; `1/2/1032/1037` abandon with stable families; anything else never maps to money and surfaces as `STK_RESULT_<code>` (`backend-go/internal/daraja/callbacks.go`; error taxonomy in `backend-go/internal/daraja/README.md`). | None — the mapping is closed by construction. |
| D7 | B2C payout result re-used as an inflow payment | Tampering | B2C results are OUTFLOW evidence: `observed`, never ledgered, never an inflow command (`backend-go/internal/daraja/intake.go` `KindB2CResult → OutcomeObserved`; `backend-go/internal/daraja/b2c.go`). C2B *validations* are likewise gates (`acknowledged`), not money facts — only the confirmation is ledgered. | None — the kind switch is exhaustive and defaults to refusal (`CodePayloadUnrecognized`). |
| D8 | Daraja client credentials leak through errors/logs | Information disclosure | Config is env-only (`ConfigFromEnv` refuses to boot without `DARAJA_CONSUMER_KEY`/`DARAJA_CONSUMER_SECRET` and documents "never hardcoded": `backend-go/internal/daraja/client.go`); the README pins "env-only, never logged" and B2C passkeys/`SecurityCredential` are per-call service-injected inputs (`backend-go/internal/daraja/README.md`); structured logging is redaction-disciplined (`backend-go/internal/observability/logging.go`). | Log-redaction is a denylist discipline; see secrets runbook §3 and the review rule "no credential-shaped values in log lines". |
| D9 | Callback floods (double-click / retry storm) | Denial of service | The client collapses **concurrent** same-key initiations onto one wire call (in-flight guard — double-click protection: `backend-go/internal/daraja/stk.go`, README §"R9 truth stays in the domain"); retry policy is exponential backoff + jitter on network/5xx only, 4xx never retried (`backend-go/internal/daraja/client.go`). | The in-flight guard is per-process. Multi-replica initiations rely on the durable intake ledger (D2) to collapse to one money fact. |

STK push as a *collections action* additionally passes the DPA consent gate
(fail-closed, BEFORE the policy engine) and the deterministic policy engine
(deny / requires_approval / allow) before any wire call:
`src/domain/collections/stk/gate.ts`, `src/domain/collections/stk/actions.ts`
(`proposeStkPush → gateStkPush → initiateStkPush → reconcileStkCallback`,
audited throughout via `src/domain/collections/stk/audit.ts`).

---

## 3. B2 — Webhook signing & delivery (outbound, developer platform)

Far side: the customer-configured HTTPS endpoints that receive signed events.
The wire contract is pinned by the TS spec `src/domain/webhooks/signing.ts`
and ported 1:1 (test vectors included) into
`backend-go/internal/webhooks/signing.go`.

Signature scheme: canonical string `<unixMillis>.<payload>`; header
`t=<unixMillis>,v1=<lowercase hex>`; HMAC-SHA256.

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| W1 | Payload tampering between us and the receiver | Tampering | Every delivery is signed over the canonical string `<unixMillis>.<payload>` with the endpoint secret (`backend-go/internal/webhooks/signing.go` `CanonicalString`, `Sign`, `HMACSHA256`); the sender renders `t=…,v1=…` (`FormatSignatureHeader`) when POSTing through the delivery worker (`backend-go/internal/webhooks/worker.go`, injected `Transport` port `backend-go/internal/webhooks/transport.go`). | Receiver must actually verify. The verify decision table (MALFORMED → STALE_TIMESTAMP → MISMATCH, order pinned) is provided for receivers (`signing.go VerifySignature`); we cannot force external receivers to run it. |
| W2 | Replay — a captured (payload, header) pair re-presented within the skew window | Spoofing (freshness), Elevation of privilege | Two layers. (a) Freshness: the header timestamp must sit inside the ±300 000 ms skew window (inclusive) or the decision is `STALE_TIMESTAMP` (`DefaultMaxSkewMs`, `signing.go VerifySignature`). (b) The sticky replay ledger: `VerifyDeliverySignature` records one decision per `(endpointId, deliveryId)`; a replay returns the SAME decision without recomputing, and every rejection — first sight AND replays — re-emits the `webhook.signatureRejected` audit fact with `replay: true` (`backend-go/internal/webhooks/signing.go`, `VerificationLedger`, `SignatureRejected`; TS parity `src/domain/webhooks/signing.ts` `verifyDeliverySignature`). | The ledger is an injected map: a receiver that keeps it only in memory loses stickiness on restart. Receivers must persist `(endpointId, deliveryId)` decisions to make replay protection survive restarts. The ≤5 min window is also the attacker's window *before* the ledger is consulted — the ledger is what closes it, hence (b). |
| W3 | Forgery without the secret / secret theft from the database | Spoofing, Information disclosure | Secrets never live in the schema: `webhook_endpoints` stores `secret_hash` + `secret_prefix` (identification) only, plaintext shown exactly once at creation (`db/migrations/0012_webhooks.sql` — invariants header + `ck_webhook_endpoints_secret_shape`). The worker resolves plaintext secrets through the injected `SigningKeys` port — "a KMS adapter is the production drop-in" (`backend-go/internal/webhooks/worker.go`, interface `SigningKeys.SecretFor`). Digest comparison is constant-time (`hmac.Equal`, `signing.go VerifySignature`). | Until the KMS adapter is bound, the operator's secret source is the process environment (see secrets runbook §4) — env discipline is the load-bearing control. `SigningKeys` implementations must never embed secret material in errors (documented on the port). |
| W4 | Malformed / hostile signature headers (parser fuzzing) | Denial of service, Information disclosure | The header parser is TOTAL — never throws; anything not matching `t=(1..19 digits),v1=(16..256 lowercase hex)` (reordered, uppercase, wrong length, unsafe-integer timestamp) feeds the `MALFORMED` decision (`signing.go ParseSignatureHeader`, `signatureHeaderPattern`, safe-integer guard at 2^53−1 so a TS receiver's `Number()` round-trip agrees). | None — parsing is total and decision-valued by construction. |
| W5 | SSRF — a webhook endpoint pointing at internal infrastructure | Elevation of privilege, Information disclosure | Endpoint URLs are constrained at the schema: HTTPS-only (`ck_webhook_endpoints_https`) and loopback refused — `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, v4-mapped loopback (`ck_webhook_endpoints_no_local`) (`db/migrations/0012_webhooks.sql`). | Private-range *external* addresses (RFC1918, link-local, cloud metadata IPs) resolve past the shape CHECKs. Defense-in-depth before public launch: egress allow-listing / DNS-pinning at the network layer. Flagged as follow-up, not silently assumed. |
| W6 | Double-enqueue / delivery duplication creating duplicate side effects on receivers | Tampering (of receiver state), Repudiation | Enqueue is idempotent: `UNIQUE (org_id, endpoint_id, event_id)` — replays of the same event cannot double-enqueue (`db/migrations/0012_webhooks.sql`). Delivery is claim-then-post-then-record (at-least-once): a crash between POST and record leaves the row `delivering` until the claim lease expires, then a fresh worker redelivers — receivers are told to dedupe by event id (the signed envelope's `aggregateId`) (`backend-go/internal/webhooks/worker.go` constraint map; attempt ladder `backend-go/internal/webhooks/attempts.go`, exhaustion → dead-letter terminal). | Receivers that do not dedupe will see at-least-once duplicates. This is a documented contract, not an enforced one. |
| W7 | Timing side channel on signature comparison | Information disclosure | `hmac.Equal` (constant-time byte comparison) in `signing.go VerifySignature` — the same MISMATCH decision without the timing leak. | None — stdlib primitive. |

---

## 4. B3 — Payer portal tokenization (httpOnly cookie + BFF)

Far side: payer browsers (untrusted, potentially hostile JS environment).
The portal's credential is a portal access code — an auth-lane
`bearerSession` credential (the same scheme the dashboard uses). The payer
pastes it ONCE; afterwards the credential lives server-side only.

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| P1 | Credential theft from the browser (XSS, extensions, dev-tools shoulder-surf) | Information disclosure | The access code is pasted once, validated against the live API, then held ONLY in an `HttpOnly` cookie — never readable from browser JS, never in `localStorage`/`sessionStorage`, never in a URL (`frontend/src/lib/portal/session.ts` cookie contract; setter `frontend/src/lib/portal/session-route.ts` — no cookie is ever set for a credential the API refused). Cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/`, `Max-Age` bounded at 8 h (upstream idle/absolute expiry can end it sooner; 401s surface honestly). | HttpOnly does not stop a compromised *server-side* BFF; it stops browser-JS theft. Shoulder-surfing the paste step is out of software's reach. |
| P2 | Credential leakage through URLs / Referer / logs | Information disclosure | The credential arrives in the JSON request **BODY** — never a query string (`frontend/src/app/(portal)/api/portal/session/route.ts` + `frontend/src/lib/portal/session-route.ts`). The BFF strips the browser `Cookie` header and hop-by-hop headers upstream and attaches `Authorization: Bearer <token>` **server-side only** (`frontend/src/lib/portal/bff.ts` — `PASSTHROUGH_HEADERS` allow-list, `STRIPPED_HEADERS` deny-list; adapter `frontend/src/app/(portal)/api/portal/v1/[...path]/route.ts`). | The allow-list passes `x-request-id`/`x-correlation-id` through — request ids are opaque UUIDs, not credentials; keep it that way in review. |
| P3 | CSRF against portal operations | Tampering, Spoofing | `SameSite=Strict` on the portal cookie — the portal is cross-site-needless, so Strict is the tightest correct policy and cross-site requests simply do not carry the cookie (`frontend/src/lib/portal/session.ts`). | Strict covers cookie carriage, not top-level navigation abuse (none applies: the portal drives no state-changing GETs — review rule: keep mutations behind non-GET BFF relays). |
| P4 | Direct API calls bypassing the portal gate | Elevation of privilege | The access code IS an auth-lane session credential: the API enforces its own 401/403 on every operation (B4). The BFF fails closed when the cookie is absent — the browser gets the contract-shaped 401 envelope instead of a header-less upstream call (`frontend/src/lib/portal/bff.ts` `contractUnauthorized`); an unset `API_BASE_URL` fails closed with the generic 500 envelope, cause logged not leaked (`frontend/src/app/(portal)/api/portal/v1/[...path]/route.ts`). | None beyond the API's own authz surface (B4) — the portal adds no authority of its own. |
| P5 | Portal/dashboard credential confusion | Spoofing | The portal cookie is `fuatilia_portal_session`, deliberately distinct from the dashboard's `fuatilia_session` — the two surfaces never share a credential (`frontend/src/lib/portal/session.ts`; dashboard counterpart `frontend/src/lib/auth/session.ts`). | None — distinct names by construction. |
| P6 | Credential stuffing / brute-force at the gate | Spoofing, Denial of service | Gate refusals relay the API's contract envelope (status, code, requestId) so refusal is observable but non-inventive (`frontend/src/lib/portal/session-route.ts`); bodies are capped at 4 KiB before parsing (`MAX_BODY_BYTES`); the API side rate-limits per principal+IP and per client-IP (B5). | No CAPTCHA / device fingerprinting — brute-force resistance is the API limiter's budget. Revisit if portal-gate noise shows in metrics. |

Dashboard symmetry (same discipline, separate lane): `fuatilia_session`
cookie with `SameSite=Strict` + edge middleware gate
(`frontend/src/lib/auth/session.ts`, `frontend/src/middleware.ts`,
`frontend/src/lib/auth/gate.ts` — the redirect carries the requested PATH
only, never a credential).

---

## 5. B4 — AuthN/AuthZ and org isolation (Go API kernel)

Far side: any bearer of an Authorization header (operator browsers via BFF,
API keys, and anyone replaying a stolen one).

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| A1 | Credential forgery or scheme confusion | Spoofing | `ParseAuthorization` understands exactly two schemes — `Bearer <sessionToken>` and `ApiKey <id>.<secret>` (split at the FIRST dot); anything else is malformed and refused (`backend-go/internal/auth/authenticator.go`). API-key secrets are stored as SHA-256 hex and verified **constant-time** (`backend-go/internal/auth/codec.go` `Verify` via `hmac.Equal`; store projection hash + prefix only, never plaintext: `backend-go/internal/repositories/authstore.go`). There is NO password login: `password_hash` is an unusable random verifier — credentials are minted as sessions and API keys only (`backend-go/internal/repositories/authstore.go` `InsertUser`; `backend-go/internal/application/authadmin.go` `unusablePasswordHashComment`). | SHA-256 (unsalted) over ≥16-char high-entropy secrets is acceptable for *generated* keys, not for human passwords — which is precisely why human passwords do not exist in this system. Keep it that way. |
| A2 | Cross-tenant access (tenant A reads/mutates tenant B) | Elevation of privilege, Information disclosure | Org identity comes ONLY from the verified principal — `principal.OrgID` — never from request input, and every repository query pins `org_id = $1` (representative: `backend-go/internal/repositories/payments.go`, `backend-go/internal/repositories/cases.go`, `backend-go/internal/repositories/receivables.go` — list/detail/insert all lead with `org_id`). Handlers pass `principal.OrgID` into the application services (`backend-go/internal/transport/routes.go`, e.g. `/v1/payments/intake` → `svc.Intake(rc.context(), principal.OrgID, …)`); the kernel resolves the principal before any handler runs (`backend-go/internal/transport/kernel.go`). Authz is deny-by-default over a closed permission vocabulary: unknown permission → refuse; inactive principal → refuse; no covering rule → `NO_GRANT` (`backend-go/internal/auth/guard.go` `Can`). | Isolation is by query discipline (every SQL statement leads with `org_id`), not PostgreSQL row-level security. A new repository query that forgets the `org_id` predicate is the residual hole — the review rule "every query leads with org_id" plus the org-scoped indexes added for exactly these shapes (`db/migrations/0015_read_model_indexes.sql`) keep it checkable. |
| A3 | Privilege escalation through grants | Elevation of privilege | A granter cannot confer authority they do not hold: the escalation guard diffs the role definition against the granter's effective permissions (`backend-go/internal/auth/guard.go` `EffectivePermissions`, `MissingForRole`); refusal is the stable `AUTH_ESCALATION_BLOCKED` and is AUDITED as `auth.escalationBlocked` before the 403 is emitted (`backend-go/internal/application/authadmin.go` `GrantRole` + `GrantOption.AuditEscalationRefusal`; `backend-go/internal/auth/authenticator.go` `AuditEscalationRefusal`). Wildcards are legal ONLY inside role definitions, never per grant or key scope (`guard.go` `IsRoleWildcard`, `AssertPermission` → `AUTH_PERMISSION_WILDCARD_FORBIDDEN`). | Org-wide authorization only on the mounted /v1 surface (no resource parameter → scope-refusal edges like `NOT_IN_RESOURCE_SCOPE` are unreachable); resource-scoped grants exist in the schema but do not narrow /v1 decisions today. Fine-grained narrowing is future work, not a hidden assumption. |
| A4 | Denials happening off the record (repudiation of access attempts) | Repudiation | EVERY 401 and 403 — including "no header at all" — is audited through the sink bound to the tamper-evident `audit_events` chain; a refusal that cannot be audited fails CLOSED to 500 (it must never surface as a 4xx without its audit fact) (`backend-go/internal/auth/authenticator.go` `Authenticate`/`refuse`/`Authorize` — `InternalErr` discipline; `backend-go/internal/infra/audit.go`, hash-chained per org in `db/migrations/0013_audit_outbox.sql`). | Audit-write availability gates auth availability (by design). Alert on audit-write failures. |
| A5 | Suspended / deactivated / revoked principals acting | Spoofing | Principal status is checked before any rule evaluation: `suspended` / `deactivated` / `revoked` map to stable refusal reasons; unknown statuses fail safe to `PRINCIPAL_DEACTIVATED` (`backend-go/internal/auth/guard.go` `Can`, `statusReasons`). API-key ownership cascades: a key acts on its OWNER user's identity, so the owner's status gates the key (`guard.go` `Principal.UserID` doc; `backend-go/internal/repositories/authstore.go`). | None — status is read per verification, not cached past it. |
| A6 | Stolen bearer session replayed from another context | Spoofing | Sessions are opaque UUIDs (`bearerSession`), verifiable only against the live store, revocable via `POST /v1/auth/sessions/revocations` (`backend-go/internal/application/authadmin.go` `CodeSessionNotFound`, `CodeSessNotActive`; reason required — `AUTH_REASON_REQUIRED`). Browsers never hold the token in JS (B3 cookie discipline, `frontend/src/lib/auth/session.ts`). | No device/IP binding on sessions; a stolen cookie value works until revoked or expired. Detection relies on the audited-denial trail + rate limiting (B5). |

---

## 6. B5 — Rate limiting & transport hardening (just landed, issue #130)

Far side: anonymous internet traffic hitting `/v1` (public rows answer
without auth) and authenticated clients under load.

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| R1 | Brute-force / credential stuffing / scraping | Spoofing, Denial of service | Token-bucket limiter keyed per principal+IP on permission-carrying routes (checked AFTER authentication — the principal owns the budget, the IP keeps tenants sharing an egress address in distinct buckets) and per client-IP on public routes (`backend-go/internal/transport/ratelimit.go`; kernel wiring `backend-go/internal/transport/kernel.go` `KernelOptions.Limits`/`LimitStore`). Defaults: 300 req/min per key, burst = the minute budget; refusals answer 429 with the contract envelope + `Retry-After`. Env-tunable (`FUATILIA_RATE_LIMIT_RPM`/`_BURST`, documented in `.env.example`). | The default store is in-memory, per-process. Horizontal scale needs a shared store bound behind the `RateLimitStore` port (the seam exists, documented on the option). A `0` RPM value DISABLES limiting — a config foot-gun; deploy validation should assert it is set. |
| R2 | Oversized-body parser exhaustion | Denial of service | Kernel caps request JSON bodies (`MaxBodyBytes`, default 1 MiB — `backend-go/internal/transport/kernel.go` `KernelOptions.MaxBodyBytes`). The portal gate independently caps at 4 KiB (`frontend/src/lib/portal/session-route.ts`). | None beyond the cap — handlers parse pre-capped bodies. |
| R3 | Clickjacking, MIME sniffing, referrer leakage, protocol downgrade | Tampering, Information disclosure | Four unconditional security headers on EVERY response (success, refusal, 429, panic recovery): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (request URLs carry org/resource ids), `X-Frame-Options: DENY` (`backend-go/internal/transport/securityheaders.go`). HSTS is flag-gated (`FUATILIA_HSTS_ENABLED`) so it is enabled only once TLS termination is real — enabling it on plain HTTP would hard-pin clients. | HSTS off by default: TLS posture is the deployment's job (`docs/DEPLOY.md` TLS story). The API itself is a JSON surface with no browser app behind it; the browser surfaces carry their own Next.js headers. |

---

## 7. B6 — Admin surface (auth administration)

Far side: org admins — the highest-authority humans in the system, and
therefore the most valuable credentials to steal.

| # | Threat | STRIDE | Mitigating code (verified paths) | Residual risk |
|---|--------|--------|----------------------------------|---------------|
| M1 | Unauthorized role administration | Elevation of privilege | All six `/v1/auth/*` admin rows require `admin:manage-users` (`backend-go/internal/transport/routes.go` `authAdminRoutes` — users create, role grants/revocations, API keys, session revocations); the kernel authenticates + authorizes BEFORE any handler runs and audits every denial (B4/A4). Admin operations are org-scoped — every service call receives `principal.OrgID` (`routes.go` handlers; `backend-go/internal/application/authadmin.go`). | `admin:manage-users` is org-scoped but otherwise flat — no second-admin approval, no step-up auth. Compromise of one admin credential is compromise of the org's identity plane (see M2's residual). |
| M2 | Admin grants themselves/peers unheld authority | Elevation of privilege | The escalation guard refuses any grant of authority the granter does not hold and audits the refusal (`AUTH_ESCALATION_BLOCKED`, `auth.escalationBlocked`) — B4/A3 applies with full force here because admin rows ARE grant operations (`backend-go/internal/application/authadmin.go`; `backend-go/internal/auth/guard.go` `MissingForRole`). | A genuinely omni-potent admin (holding the full wildcard role definition) can confer anything they hold — that is what admin means. Compensating control: every grant lands on the audited chain with the granter's id (repudiation-resistant). |
| M3 | API-key sprawl and over-scoped keys | Spoofing, Elevation of privilege | Keys require explicit concrete scopes (`AUTH_KEY_SCOPES_REQUIRED`), reject wildcards (B4/A3), enforce minimum secret length (`AUTH_SECRET_TOO_SHORT`, min 16) and expiry validation (`AUTH_KEY_EXPIRY_INVALID`); keys store hash + prefix only and the owner's status cascades to the key (B4/A1, A5) (`backend-go/internal/application/authadmin.go`; `backend-go/internal/repositories/authstore.go`; `backend-go/internal/auth/guard.go`). | Scope review is procedural (who approves which scopes), not technical. Expiry defaults are operator-provided, not enforced minimums. |
| M4 | Revocation gaps (leavers keep sessions) | Spoofing, Repudiation | Session revocation is a first-class admin operation with mandatory reason (`POST /v1/auth/sessions/revocations`, `AUTH_REASON_REQUIRED` — `backend-go/internal/application/authadmin.go`); deactivated users fail verification on next use (B4/A5); owner deactivation cascades to API keys. | There is no login/issuance endpoint on the mounted surface yet — session credentials are administratively seeded (the honest seam documented in `frontend/src/lib/auth/session.ts` "SEAM" note). Session lifecycle before that seam lands is a manual process; keep the revocations route used on every offboarding. |

---

## 8. Residual-risk register (the honest list)

Everything above with a non-empty residual, condensed for review triage:

1. **Daraja callbacks carry no provider signature** (D1) — structural
   validation + journey ledger + initiation binding are the controls; a
   wholly fabricated C2B-confirmation journey with a fresh key can be
   accepted. Cross-check via bank-statement reconciliation
   (`src/adapters/bankfeed/feeds.ts`) + finance alerts
   on money-kind refusals.
2. **Durable journey ledger / replay-ledger persistence is a deployment
   duty** (D2, W2) — the ports (`JourneyLedger`, receiver-side verification
   ledger) must be backed by shared durable stores in production.
3. **Webhook SSRF shape-checks stop loopback but not private ranges** (W5) —
   add network-layer egress controls before public developer-platform launch.
4. **Org isolation is query discipline, not RLS** (A2) — every query must
   lead with `org_id`; review rule + org-scoped indexes keep it checkable.
5. **Rate limiter is per-process and disable-by-zero** (R1) — bind a shared
   `RateLimitStore` when scaling; assert RPM is configured in deploys.
6. **HSTS is off until TLS termination is real** (R3) — deployment-level
   control; documented in `docs/DEPLOY.md`.
7. **Admin surface has no step-up auth / second-approval** (M1) — the audit
   chain is the compensating control; revisit before multi-admin orgs ship.
8. **No automated secret scanner in CI yet** — see secrets runbook §6 for
   the manual discipline and the follow-up.

Review cadence: re-verify every cited path and re-triage this register at
each wave boundary and on any new trust boundary (new provider callback, new
browser surface, new admin route). The file's cited-path list doubles as the
checklist — a path that no longer exists is a documentation bug AND likely a
regression.

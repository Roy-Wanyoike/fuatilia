# Daraja production client (`backend-go/internal/daraja/`)

**issue #96 / PRODUCT_ROADMAP P1.3** — the production Safaricom Daraja REST client for the Go
backend. The TS lane (`src/adapters/daraja/`) remains the behavioral spec: this package ports
the K1 untrusted-input boundary with the SAME stable `DARAJA_*` codes, the same wire patterns
(`TransID` `[A-Z0-9]{10,22}`, `CheckoutRequestID` `ws_CO_…`, MSISDN `254[17]\d{8}`), and the
same money discipline (decimal strings → integer minor units, never floats; whole-shilling
initiation amounts, never rounded).

## Surface

| File | Role |
|---|---|
| `client.go` | Config (env-driven), retry policy (exp backoff + jitter on network/5xx only), 401 → re-auth-once, per-endpoint request helper |
| `oauth.go` | Bearer token lifecycle: cache + expiry skew (30s), single-flight refresh |
| `stk.go` | STK Push initiate + query; whole-shilling enforcement; double-click in-flight guard |
| `b2c.go` | B2C payout, transaction status query, C2B URL registration |
| `callbacks.go` | K1 boundary: C2B validation/confirmation, STK result, B2C result → typed evidence; malformed payloads refused with their promised code |
| `money.go` | Decimal-string → minor units (no floats), whole-shilling conversion, decimal rendering |

## Error taxonomy (AC7, issue #84)

Every `*daraja.Error` carries a coarse machine-readable `Kind` next to its
stable `Code`. The Code says what exactly happened; the Kind says who acts
and how:

| Kind | Meaning | Operator reflex |
|---|---|---|
| `auth` | credentials/permission (OAuth refusal, 401, `401.*`/`403.*` errorCodes) | alert, re-provision secrets |
| `config` | caller misuse/misconfiguration | fix the code — never retry |
| `validation` | untrusted input refused or request rejected (`400.*` errorCodes, payload refusals) | dead-letter — never retry |
| `money` | money-boundary refusal (amount shapes, whole shillings, tamper mismatch) | alert finance, dead-letter |
| `network` | transport failure, journey ledger unavailable | retry with backoff |
| `timeout` | context deadline expired (incl. expiry during backoff) | retry with a fresh deadline |
| `upstream` | Daraja unhealthy or contract-violating (5xx, `5*` errorCodes, malformed response, retries exhausted) | retry with backoff, then alert |
| `busy` | concurrent same-key initiation collapsed onto one wire call | retry after the in-flight call lands |

On rejected requests the client parses Daraja's error envelope
(`{"errorCode":"400.008.01","errorMessage":…}`, bounded 4 KiB read):
`400.*` → `validation`, `401.*`/`403.*` → `auth`, `5*` → `upstream`; the
HTTP status decides when the body carries no `errorCode`. Daraja's own code
is preserved on `Error.UpstreamCode`; its `errorMessage` joins the log-safe
`Message`.

## Environment contract

| Variable | Meaning |
|---|---|
| `DARAJA_BASE_URL` | API root; default `https://sandbox.safaricom.co.ke`; production overrides |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` | App credentials — required, env-only, never logged |

Passkeys / B2C `SecurityCredential` / initiator names are per-call inputs the SERVICE layer
injects from its own secret source — never literals in code, never in logs.

## Semantics worth knowing

- **R9 truth stays in the domain.** The client's in-flight guard only collapses *concurrent*
  same-key initiations onto one wire call (double-click protection). Completed-initiation
  dedup is the payments intake's job, exactly as the TS conformance lane proves it.
- **Unknown STK result codes fail closed** (`STK_RESULT_<code>`): 0 completes;
  1/2/1032/1037 abandon with stable families; anything else never maps to money.
- **Amounts**: failure results carry NO amount — the merchant's own initiation record (E11)
  backs the intake; without it the parse refuses (`DARAJA_STK_AMOUNT_UNKNOWN`).
- **Tests never touch network**: scriptable `httptest` fake + fake clock/sleeper.

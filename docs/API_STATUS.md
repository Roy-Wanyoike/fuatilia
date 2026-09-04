# API status — the mounted `/v1` surface vs the OpenAPI contract

> **What this doc is.** The route-by-route truth table for the FuatiliA `/v1`
> JSON surface (issues #55 + #60), checked against the machine-readable
> contract in [`api/openapi/fuatilia.v1.yaml`](../api/openapi/fuatilia.v1.yaml)
> (issue #67). It documents EXACTLY what is mounted today — nothing here is
> aspirational. Planned-but-unmounted endpoints live in the clearly-labeled
> [NOT IN SPEC](#not-in-spec-planned-next-mounts) section at the bottom.
>
> **Machine-verified.** `python3 scripts/validate_openapi.py` (exit 0) checks
> that (a) the spec validates as OpenAPI 3.1, (b) every
> `x-required-permission` exists in the closed vocabulary in
> `src/domain/auth/roles.ts`, and (c) the spec's (method, path) set is
> IDENTICAL to the rows parsed from the five route tables below.
>
> **Snapshot:** main `c65ffba` (wave 8 — 2,665 tests / 114 suites green).

## Legend

- **Mounted** — a `RouteRecord` row in a route table wired into
  `src/adapters/http/server.ts` (`createHttpKernel`). No exceptions.
- **Permission** — the route's required vocabulary permission; **public** rows
  never attempt authentication (`ctx.principal` stays null).
- **In spec** — documented in `fuatilia.v1.yaml` with `x-required-permission`,
  params, envelope, and error statuses derived from the kernel's error table.
- **Kernel tests** — the spec files covering the wire behavior
  (`server.spec.ts` is the repo's only socket-level integration test).

## Matrix — every mounted route

| # | Route | Mounted in | Permission | In spec | Kernel tests |
|---|-------|------------|------------|:-------:|--------------|
| 1 | `GET /v1/health` | `routes/public.ts` | public | ✅ | `server.spec.ts` (wire) |
| 2 | `GET /v1/meta` | `routes/public.ts` | public | ✅ | `server.spec.ts` (wire) |
| 3 | `POST /v1/auth/users` | `routes/auth.ts` | `admin:manage-users` | ✅ | `server.spec.ts` (wire: 201 / 403 / 400) |
| 4 | `POST /v1/auth/roles/grants` | `routes/auth.ts` | `admin:manage-users` | ✅ | `server.spec.ts` + `middleware/auth.spec.ts` (401/403 matrix) |
| 5 | `POST /v1/auth/roles/revocations` | `routes/auth.ts` | `admin:manage-users` | ✅ | `middleware/auth.spec.ts` (401/403 matrix) |
| 6 | `POST /v1/auth/api-keys` | `routes/auth.ts` | `admin:manage-users` | ✅ | `server.spec.ts` (wire: 400 bad scopes) |
| 7 | `POST /v1/auth/api-keys/revocations` | `routes/auth.ts` | `admin:manage-users` | ✅ | `middleware/auth.spec.ts` (401/403 matrix) |
| 8 | `POST /v1/auth/sessions/revocations` | `routes/auth.ts` | `admin:manage-users` | ✅ | `middleware/auth.spec.ts` (401/403 matrix) |
| 9 | `GET /v1/receivables` | `routes/receivables.ts` | `receivables:read` | ✅ | `routes/receivables.spec.ts` + `pagination.spec.ts` |
| 10 | `GET /v1/receivables/{receivableId}` | `routes/receivables.ts` | `receivables:read` | ✅ | `routes/receivables.spec.ts` |
| 11 | `POST /v1/payments/intake` | `routes/payments.ts` | `payments:intake` | ✅ | `routes/payments.spec.ts` (R9/C5 idempotency) |
| 12 | `GET /v1/payments` | `routes/payments.ts` | `payments:read` | ✅ | `routes/payments.spec.ts` + `pagination.spec.ts` |
| 13 | `GET /v1/payments/{paymentId}` | `routes/payments.ts` | `payments:read` | ✅ | `routes/payments.spec.ts` |
| 14 | `POST /v1/payments/{paymentId}/confirmations` | `routes/payments.ts` | `payments:intake` | ✅ | `routes/payments.spec.ts` (success-callback idempotency) |
| 15 | `POST /v1/payments/{paymentId}/refund-reservations` | `routes/payments.ts` | `payments:refund` | ✅ | `routes/payments.spec.ts` (R6 ceiling) |
| 16 | `POST /v1/collections/cases` | `routes/collections.ts` | `collections:act` | ✅ | `routes/collections.spec.ts` (R8 exclusivity) |
| 17 | `GET /v1/collections/cases` | `routes/collections.ts` | `collections:read` | ✅ | `routes/collections.spec.ts` + `pagination.spec.ts` |
| 18 | `GET /v1/collections/cases/{caseId}` | `routes/collections.ts` | `collections:read` | ✅ | `routes/collections.spec.ts` (org scoping) |
| 19 | `POST /v1/collections/cases/{caseId}/transitions` | `routes/collections.ts` | `collections:act` | ✅ | `routes/collections.spec.ts` |
| 20 | `POST /v1/collections/cases/{caseId}/escalations` | `routes/collections.ts` | `collections:act` | ✅ | `routes/collections.spec.ts` |
| 21 | `POST /v1/collections/cases/{caseId}/actions` | `routes/collections.ts` | `collections:act` | ✅ | `routes/collections.spec.ts` (K2 consent gate) |
| 22 | `POST /v1/collections/cases/{caseId}/actions/{actionId}/completions` | `routes/collections.ts` | `collections:act` | ✅ | `routes/collections.spec.ts` |

**Counts (validator-verified): 22 mounted rows = 22 spec operations over 21
paths** (public 2, auth 6, receivables 2, payments 5, collections 7);
20 permission-gated + 2 public. Every permission string above is in the
closed `PERMISSIONS` vocabulary (`roles.ts`): `receivables:read`,
`receivables:write`, `payments:read`, `payments:intake`, `payments:refund`,
`collections:read`, `collections:act`, `adjustments:request`,
`adjustments:approve`, `ledger:read`, `ledger:post`, `intelligence:read`,
`admin:manage-users`, `policy:manage`.

Cross-cutting kernel behavior (documented once in the spec, applies to every
route): envelope `{ data, meta? }` / error `{ error: { code, message },
requestId }`; `x-request-id` echoed on every response; 404
`HTTP_ROUTE_NOT_FOUND` + 405 `HTTP_METHOD_NOT_ALLOWED` (with `allow` header);
413 `HTTP_PAYLOAD_TOO_LARGE`; strict 1–100 `limit` pagination with opaque
cursors (`pagination.spec.ts`); fail-closed 500 `HTTP_INTERNAL_ERROR`
(`kernel/errors.spec.ts`); audited 401/403 denials (`middleware/auth.spec.ts`).

**Authentication (verified against `middleware/auth.ts` — not guessed):**
two schemes, either satisfies a protected route —

| Scheme | Header shape | Notes |
|--------|--------------|-------|
| `bearerSession` | `Authorization: Bearer <sessionToken>` | The token IS an auth-lane session id (opaque, not a JWT); expiry/revocation → 401 with the lane's code. |
| `apiKeyAuth` | `Authorization: ApiKey <id>.<secret>` | Split at the FIRST dot; concrete-permission scopes only; denials → 401 `KEY_*`. |

## NOT IN SPEC — planned next mounts

**Nothing in this section is mounted.** No route table row exists for any of
it, so the OpenAPI contract deliberately does NOT document it (the validator
fails if the spec ever drifts from the mounted set — in either direction).
Per the wave-8 completion note in `docs/BACKLOG.md`, the remaining `/v1`
resource mounts and hardening steps are:

| Planned surface | Vocabulary permissions already reserved | Status |
|-----------------|------------------------------------------|--------|
| `/v1/ledger/*` — posting / sub-ledger / reconciliation read+post surface | `ledger:read`, `ledger:post` | **NOT IN SPEC** — no rows in any route table |
| `/v1/adjustments/*` — credit notes, refunds (aggregate lifecycle), reversals | `adjustments:request`, `adjustments:approve` | **NOT IN SPEC** — no rows in any route table |
| `/v1/communications/*` — dunning sends / messaging surface (WhatsApp/SMS lanes exist domain-side) | none reserved yet | **NOT IN SPEC** — no rows in any route table |
| `/v1/intelligence/*`, `/v1/policy/*` | `intelligence:read`, `policy:manage` | **NOT IN SPEC** — reserved vocabulary only, no rows |
| Payment allocation / matching / unapplied-parking routes | `payments:write`-adjacent (none reserved for allocate today) | **NOT IN SPEC** — the lane's `allocatePayment`/`identifyPayment` transitions have no mounted rows; allocations reach the read model through the invoicing flow |
| Receivable write routes (open/void/write-off/uncollectible on the wire) | `receivables:write` | **NOT IN SPEC** — receivables are read-only this wave (rows arrive via the invoicing flow / persistence adapters) |
| Auth session ISSUE (login), role definition, user listing routes | `admin:manage-users` | **NOT IN SPEC** — only the admin command rows above are mounted |
| Persistence adapters per resource store (file-backed auth exists — F32) | n/a (storage, not wire) | **NOT IN SPEC** — the wire surface does not change |

When any of these mount, they arrive as appended `RouteRecord` rows (no
kernel changes), the spec gains exactly those paths, and
`scripts/validate_openapi.py` enforces the match.

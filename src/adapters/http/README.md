# HTTP transport lane — wave 7 (issue #55, SPEC §38)

The FIRST transport lane: mounts the completed domain core behind a versioned
`/v1` JSON surface. **Zero new npm dependencies** — the kernel is built on
`node:http` alone, and every cross-cutting concern is deterministic and
handler-level testable with synthetic requests (no sockets).

```text
node:http (server.ts — the only socket-aware file)
  → kernel.handle (router → body → auth middleware → handler → envelope)
      → src/domain/** (the completed capability lanes)
```

## Scope

- **`kernel/`** — the deterministic core:
  - `router.ts` — `/v1`-prefixed pattern matching with `:params`; `404`
    `HTTP_ROUTE_NOT_FOUND` + `405` `HTTP_METHOD_NOT_ALLOWED` (with the sorted
    allow list); composition-time registration validation (illegal segments,
    duplicate params/rows) fails fast instead of mis-routing at runtime;
  - `body.ts` — JSON body parse with a byte cap (`HTTP_PAYLOAD_TOO_LARGE`),
    malformed JSON → `HTTP_BODY_MALFORMED`; request-id resolution (accept
    `x-request-id`, else generate via the injected id port) echoed in the
    `x-request-id` response HEADER and every error envelope;
  - `errors.ts` — `statusForCode`, the §38 error-mapping table: EXACT
    overrides (audited auth denials → 403, key/session denials → 401), PREFIX
    families (`SESSION_`/`SESS_`/`KEY_`/`PRINCIPAL_` → 401), SUFFIX rules
    (`*_TAKEN/_EXISTS/_DUPLICATE/_MISMATCH` → 409, `*_EXPIRED` → 422,
    `*_INVALID/_REQUIRED/...` → 400, ...), `*_NOT_FOUND` → 404 — everything
    unmapped → 500 with a GENERIC message (fail closed, never leak);
  - `types.ts` — `RouteRecord` registration TABLE: later waves mount more
    resources by appending rows, never by touching kernel files.
- **`pagination.ts`** — §38 consistency helpers: `parsePagination` (limit
  1–100, default 20 — strict boundaries, NEVER silently clamped) + opaque
  cursor; `parseSorting` against a per-resource whitelist (arbitrary client
  sort strings are how you scan a database); `paginatedMeta`.
- **`middleware/auth.ts`** — the 401/403 boundary over the auth lane:
  - `Authorization: Bearer <sessionToken>` | `ApiKey <id>.<secret>` (split at
    the FIRST dot) → the injected `AuthPort` → `Principal`;
  - 401 `HTTP_UNAUTHENTICATED` — no/malformed header or the lane refused the
    credential; the lane's stable denial code passes through so clients can
    distinguish WHY (`KEY_REVOKED`, `SESSION_IDLE_EXPIRED`, ...);
  - 403 `AUTH_ACCESS_DENIED` — authenticated but `can(principal, permission)`
    denied; the refusal message IS the lane's `CanDecision` detail;
  - EVERY denial (including "no header at all") is audited as the lane's
    `auth.accessDenied` event via the port's `onDenied` sink — deny-by-default
    is a fact (SPEC §37);
  - no secret material is ever echoed or logged.
- **`runtime/memory.ts`** — the in-memory reference composition: adapts the
  auth lane's pure functions to the `AuthPort`, a SHA-256 secret codec, and
  `seedWorld` (a minimal admin org seeded through the REAL domain functions).
  Persistence-backed adapters replace this without touching the kernel.
- **`routes/`** — mounted in this PR: `GET /v1/health` + `GET /v1/meta`
  (public) and the `/v1/auth/*` admin table (user create, role grant/revoke,
  api-key issue/revoke, session revoke) — each row declares its required
  permission.
- **`server.ts`** — composition root; adapts node:http INTO the kernel's
  value-shaped `handle` (headers lowercased, URL-parsed query, chunk-wise
  UTF-8 body, over-limit bodies never buffered).

## Testing posture

Handler-level via `kernel.handle` with synthetic requests for everything
(router, envelope, error mapping, pagination, auth matrix) + ONE socket
integration spec (`server.spec.ts`) that spins a real ephemeral server
(`listen(0)`) and drives `fetch` end-to-end — the only socket test in the
repo, kept small and robust on purpose.

## Boundary contract

- The kernel NEVER owns credentials or policy — it delegates to the auth lane
  and reports what the lane decided.
- Handlers are SYNCHRONOUS and return 2xx or throw `DomainError`; the kernel
  owns the envelope, the mapping and the audit of refusals.
- Later waves (fund-truth, collections, platform resources) append route
  rows; no kernel file changes.

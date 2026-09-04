# FuatiliA Frontend (`frontend/`)

Next.js 15 / React 19 web console for FuatiliA — the AR & collections platform
for Kenya. This lane lands the **frontend foundation + the Collections Command
Center read path** (issue #76) against the frozen `/v1` contract in
`api/openapi/fuatilia.v1.yaml` (v1.0.0, 22 operations over 21 paths).

Nothing in this app is a mock dashboard: every number is derived from typed
rows fetched over the real client, and when the backend is unreachable the UI
shows the real refusal (contract code + `requestId`), never invented rows.

---

## Run

```bash
cd frontend
npm install          # Node >= 20 (engines)
npm run dev          # http://localhost:3000
npm run build        # production build (gate 1)
npx vitest run       # unit + contract + screen tests (gate 2)
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
```

Both gates (`npm run build` and `npx vitest run`) must be green before push —
they are the documented merge gate while GitHub Actions is billing-locked.

### Environment variables

| Variable              | Side   | Meaning                                                                        |
| --------------------- | ------ | ------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_BASE`| browser| Direct browser → API base URL. Unset ⇒ same-origin BFF `/api/v1` (default).    |
| `API_BASE_URL`        | server | Upstream API origin the BFF route handler relays to, e.g. `http://localhost:3000`. Unset ⇒ the BFF fails closed with a generic 500 envelope (cause logged, never leaked). |

The default composition (browser → `/api/v1` BFF → API) is the recommended
one: credentials never enter browser JS (next section).

---

## Auth at the seam

The contract authenticates protected operations with
`Authorization: Bearer <sessionToken>` (spec `components.securitySchemes.bearerSession`
— the token **is** the auth-lane session id) or `Authorization: ApiKey <id>.<secret>`.

**Browser contract (documented, enforced):** the session id lives in an
**HTTP-only cookie** `fuatilia_session` (`SameSite=Lax`, `Secure` in
production, `Path=/`). It is never stored in `localStorage`/`sessionStorage`
and never readable from client JS. Two server surfaces consume it:

- `(dashboard)/layout.tsx` — server-component gate: renders the dashboard only
  when a cookie-shaped session is present, else the designed
  `SignInRequired` screen.
- `app/api/v1/[...path]/route.ts` + `lib/server/forward.ts` — the same-origin
  BFF: relays `/api/v1/*` to `<API_BASE_URL>/v1/*` with
  `Authorization: Bearer <session>` attached **server-side**; cookie absent ⇒
  a contract-shaped 401 envelope (`HTTP_UNAUTHENTICATED`, spec lines
  2619–2623) instead of a header-less upstream call.

**Stub at the seam (honest):** the mounted `/v1` surface exposes session
**revocation** but no session **issuance** (login) yet — session creation lands
with the backend auth lane. Until then the gate enforces the cookie contract's
presence + shape only (`looksLikeSessionToken`, opaque UUID), and the sign-in
screen says so. Dev tip: seed the cookie with a real auth-lane session id to
exercise the read path.

Direct-mode caveat: with `NEXT_PUBLIC_API_BASE` set, browser calls carry no
credential (the client's `authTokenProvider` is unset), so protected reads
answer 401 envelopes that surface in-page with their code — the seam is
visible, not papered over.

---

## Collections Command Center (issue #76)

`/collections` — seven sections, "what should my collections team do right
now?". The mounted surface has **no aggregate endpoints**, so the sections are
derived client-side over the three typed read models
(`lib/derivation/command-center.ts`), all rules using contract fields only:

| # | Section | Derivation |
| - | ------- | ---------- |
| 1 | Expected collections today | `GET /v1/receivables` — balance of `open\|partially_paid` rows with `dueDate` = today (`Africa/Nairobi` day key) |
| 2 | Overdue | same rows flagged `overdue` by the lane, + aging-bucket histogram (0-30 / 31-60 / 61-90 / 90+) |
| 3 | At-risk | same rows with aging bucket ∈ {61-90, 90+} |
| 4 | Promises due | `GET /v1/collections/cases` — live cases (`open\|in_progress`) with `derivedStatus: 'promised'`; due-now = uncompleted action scheduled ≤ today |
| 5 | Missed promises | promised cases with an uncompleted action scheduled **before** today |
| 6 | Unmatched payments | `GET /v1/payments` — `confirmed ≠ null` and `unapplied.minor > 0`; total = Σ unapplied |
| 7 | High-value opportunities | top 5 outstanding rows ranked by balance (integer minor units) + book total |

**v1 limitations (disclosed, not hidden):** the promise read model (amount +
due date per promise) is not on the wire yet, so "promised" is the case-lane's
derived overlay; at-risk is the deep-aging proxy, not the risk engine's score;
large datasets stop at the client page cap (5 pages × 100 rows) and the UI
says so (`truncated: true` → status notice). Server-side aggregation and the
dedicated promise endpoint are roadmap.

**Money** is integer minor units end to end (`Money { minor, currency }`).
Rendering goes through `lib/money.ts::formatMoney` (exact BigInt/string
arithmetic, `KES 12,500.00` style). Mixed-currency sums **refuse** (`null` →
count-only presentation); beyond-`MAX_SAFE_INTEGER` sums refuse too — money
never rounds silently (R10).

### Per-card states

Every card renders exactly one of four real states
(`data-card-kind` attribute on the region):

- `loading` — skeleton, region `aria-busy`;
- `empty` — source-empty (read model has no rows) vs subset-empty (rows exist,
  this section is 0), each with its own honest copy;
- `error` — the tagged refusal (contract code, message, `requestId`) + Retry;
- `loaded` — the real derived metrics.

The dead-backend acceptance case is tested with the **real fetch stack**
against `http://127.0.0.1:9` (ECONNREFUSED): all seven cards land in
transport-error state and no fabricated business row exists anywhere in the
component tree.

---

## Tests & fixtures

- `src/lib/api/contract.test.ts` — the client decodes every success example in
  the committed spec, decodes every error example to a **tagged refusal**
  (never throws), **refuses unknown error codes** (`unknown-error` with
  `rawCode`), and pins `KNOWN_ERROR_CODES` to **set equality** against the
  spec's `ErrorCode` description block (no drift possible without a failing
  test).
- `src/lib/api/fixtures.test.ts` — pins each fixture's distinctive scalars
  against the committed spec text (provenance-by-fragments; no YAML parser in
  the dependency budget).
- `src/components/command-center/collections-screen.test.tsx` — per-card
  loading/empty/subset-empty/error/loaded states, 401 + 404 envelopes,
  dead-base-URL, retry-then-recover, truncation notice. All business rows live
  **only** in `src/lib/api/fixtures/` (test files import them; production
  modules import nothing from there), each carrying provenance comments with
  spec line numbers.
- `src/components/command-center/command-center.a11y.test.tsx` — the a11y
  baseline (below).

### A11y baseline

Semantic landmarks (banner/nav/main in the shell, skip-to-content link),
`section` labelled by the `h1`, per-card `role="region"` with accessible
names, `aria-busy` + `aria-hidden` skeletons, `aria-current="page"` nav, real
text metrics, focus-visible outlines, tables with `scope="col"` headers.
Deeper audits (axe CI, screen-reader matrices) are roadmap.

---

## Architecture

```
src/
  app/                        Next App Router
    (dashboard)/              session-gated shell: /, /collections, /payments,
                              /reconciliation, /customers, /settings
    api/v1/[...path]/route.ts same-origin BFF (cookie → Bearer relay)
  components/
    command-center/           CollectionsScreen + CommandCard (4-state card)
    shell/                    AppShell (nav, capability awareness), SignInRequired
    ui/                       Card, Button, Badge, Table, Empty/Error states, Skeleton
  lib/
    api/                      typed client, strict zod wire schemas, error-code
                              union, bounded pagination walk, fixtures (test-only)
    auth/session.ts           httpOnly cookie contract (presence + shape)
    derivation/               the seven Command Center derivations (pure)
    money.ts, dates.ts        exact money rendering; Africa/Nairobi day keys
    server/forward.ts         pure BFF forwarder (Web-standard Request/Response)
  providers/                  TanStack Query (retry: false — refusals are values)
```

House rules mirrored from the backend lanes: refusals are **tagged values**
(no throwing for expected outcomes), injected **clock** (no real `Date.now()`
under test), strict schemas (unexpected wire fields are contract drift →
`decoding-error` refusal), client-side query validation before any fetch.

### Capability awareness

`AppShell` calls public `GET /v1/meta` and labels nav sections whose
capability is not mounted as "planned" — only after meta has **answered**
(a failed probe never claims a surface is planned). `/reconciliation`,
`/customers` and `/settings` render their real emptiness (no mounted read
model ⇒ no fabricated admin/customer/matching tables).

---

## Version pins (workable stable set)

- **Next 15.5.4 / React 19.1.0** — current stable App Router pair;
  `cookies()` is awaited (async request APIs).
- **Tailwind 3.4.x** (not v4) — most stable PostCSS integration with Next 15,
  zero extra tooling.
- **zod 3.24.x** (not v4) — `.strict()` object semantics + enum composition
  the wire schemas lean on.
- **Vitest 3.x + Testing Library 16** — jsdom environment, `jest-dom/vitest`
  matchers.
- **@tanstack/react-query 5, react-table 8** — server-state + manual
  server-pagination for `/payments`.
- ESLint intentionally absent this lane (foundation scope); `tsc --noEmit` +
  vitest + build are the gates.

## Roadmap

1. **Session issuance** lands on `/v1` → real sign-in flow, session refresh,
   gate validates against the auth lane (cookie contract unchanged).
2. **Aggregate endpoints** (`/v1/collections/command-center` or equivalent) →
   move derivations server-side; the client page cap disappears.
3. **Promise read model** on the wire → promises/missed cards show amounts
   and due dates, not just case numbers.
4. **Risk engine integration** → at-risk becomes score-based (SPEC §25),
   deep-aging stays as the fallback definition.
5. **Mutation lanes** — case transitions/escalations/actions, payment
   confirmations, API-key admin (react-hook-form is already a dependency).
6. **A11y deepening** — axe in CI, full keyboard matrix, reduced-motion pass.

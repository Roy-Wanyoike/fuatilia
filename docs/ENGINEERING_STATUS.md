# ENGINEERING_STATUS — honest board at `c65ffba`

> **Commit of record:** `c65ffba` — "docs: wave-8 complete — /v1 resource mounts + file-backed
> auth persistence merged; 2,665 tests / 114 suites" (`origin/main` at audit time).
>
> Wave-by-wave history lives in [docs/BACKLOG.md](BACKLOG.md) (waves 1–8, each with PRs,
> test deltas and combined-main totals). The verified evidence behind every row below is in
> [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md); the forward plan is
> [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md); the architecture commitments are
> [DECISIONS.md](DECISIONS.md).

---

## 1. Current facts (verified locally this session)

| Fact | Value | How verified |
|---|---|---|
| Test suite | **2,665 passed / 2,665 (114 suites passed / 114)** | `npx vitest run` → "Test Files 114 passed (114), Tests 2665 passed (2665)" |
| TypeScript | **typecheck clean** | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) → exit 0 |
| Node | ≥ 22 required (`package.json` `engines`); suite run on Node 24 | `package.json` |
| Runtime dependencies | **zero** (only devDependencies: `typescript`, `vitest`) | `package.json` |
| Backlog | **32/32 features (F1–F32) merged**; 0 open PRs; 0 open issues | [docs/BACKLOG.md](BACKLOG.md) + GitHub state |
| Domain purity | `src/domain/**` has no I/O; Clock/RNG injected; only `src/adapters/daraja` imports domain lanes as its documented conformance seam | lane READMEs (`src/domain/*/README.md`), `src/adapters/daraja/README.md` |
| Tracked files | 357 (319 under `src/`, 30 under `docs/`) | `git ls-files` |
| Secret scan | clean of real credentials (only fake spec fixtures + the English phrase "risk-relevant") | the dispatch secret-scan regex (GitHub-token prefixes, key/value assignments) over tracked files |

Per-wave reconciliation of the suite total (each delta equals the merged PR's tests, per
[docs/BACKLOG.md](BACKLOG.md)): 607 (waves 1–2) → 1044 (wave 3) → 1959 (waves 4–5) →
2174 (wave 6) → 2531 (wave 7) → **2665 (wave 8)**.

---

## 2. Status board

Legend: **DONE** — merged and verified · **IN PROGRESS** — a branch/issue exists with work
underway · **BLOCKED** — work cannot proceed now, blocker named · **NOT STARTED** — no code
or artifacts exist (evidence paths in [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) §4).

### DONE (domain + first transport, waves 1–8)

| Item | Evidence |
|---|---|
| F1–F32: all 32 domain features (fund truth, collections ops, intelligence, agent platform, governance, auth, webhooks, cross-border, USSD, HTTP kernel, route mounts, auth persistence) | [docs/BACKLOG.md](BACKLOG.md) rows F1–F32; per-feature spec-file table in [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) §3.1 |
| R1–R10 invariant enforcement as tested code | [docs/07-invariants.md](07-invariants.md); lanes' spec files |
| HTTP `/v1` kernel: router, body cap, pagination, §38 error mapping, audited 401/403 middleware | `src/adapters/http/kernel/*`, `src/adapters/http/middleware/auth.ts`, `src/adapters/http/README.md` |
| 22 mounted `/v1` routes: health, meta, auth admin, receivables (read), payments (intake/read/confirm/refund-reserve), collections cases (R8/K2 mapped) | `src/adapters/http/routes/*.ts` (enumerated in the audit §3.2) |
| File-backed AuthStore persistence: JSONL journal, crash-atomic snapshots, quarantine-tolerant replay, kernel-seam restart persistence | `src/adapters/persistence/filestore.ts` + its 4 spec files |
| Daraja conformance suite (fixtures, at-least-once simulator, scenario harness) | `src/adapters/daraja/` (`src/adapters/daraja/README.md`, `src/adapters/daraja/wire.ts`, `src/adapters/daraja/simulator.ts`, `src/adapters/daraja/conformance.ts`) |
| Governance stack: policy engine, maker-checker approvals, hash-chained audit trail with redaction | `src/domain/policy/`, `src/domain/approvals/`, `src/domain/audit/` |
| Intelligence stack: scoring+feedback, projections, behavior profiles, memory, NBA, agent capabilities | `src/domain/intelligence/`, `src/domain/projections/`, `src/domain/behavior/`, `src/domain/memory/`, `src/domain/nba/`, `src/domain/agent/` |
| Design docs 01–08 + SPEC + VISION + BACKLOG | `docs/01-context-map.md` … `docs/08-build-plan.md`, `docs/SPEC.md`, `docs/VISION.md`, `docs/BACKLOG.md` |

### IN PROGRESS

- **Nothing.** At `c65ffba` there is no open feature branch, no open PR, no open issue — the
  backlog is fully merged ([docs/BACKLOG.md](BACKLOG.md) closing note: "next natural steps are
  the remaining /v1 resource mounts … and a persistence adapter per resource store").

### BLOCKED

| Item | Blocker | Notes |
|---|---|---|
| GitHub Actions CI (`.github/workflows/ci.yml`: node 22/24 matrix, typecheck+test gate) | **GitHub account billing lock** — jobs are not started by GitHub; check-run diagnostics from wave 8 record "The job was not started because your account is locked due to a billing issue" | Not a code defect; the workflow file is healthy. Resolution is an owner action in GitHub Billing. **Until resolved, the documented merge gate is: local `npm run typecheck && npx vitest run` green on Node 24** — exactly the gate used for every wave-3-to-8 merge. CI gates re-activate automatically once billing is cleared; no workflow changes are needed. |
| Any hosted demo / staging deploy | Depends on CI + deployment tooling (NOT STARTED rows below) | — |

### NOT STARTED (production platform layer — the P0/P1 work)

| Item | Status | Fastest evidence |
|---|---|---|
| Go production core (`backend/`, SPEC §41/§55) | NOT STARTED | no `go.mod` in tree |
| Next.js frontend (SPEC §41/§45–§49) | NOT STARTED | no `frontend/`, no second package manifest |
| PostgreSQL financial store + migrations | NOT STARTED | `ResourceStore` is in-memory (`src/adapters/http/runtime/resources.ts`); no SQL in tree |
| Outbox→NATS runtime | NOT STARTED | `src/domain/events/outbox.ts` is the pure contract only |
| Remaining /v1 mounts (ledger, adjustments, communications, links, disputes, promises, webhooks, crossborder, agent, …) | NOT STARTED | route enumeration — 22 rows, none of those lanes (audit §3.2) |
| Daraja production integration (network client, credentials, callback deployment) | NOT STARTED | `src/adapters/daraja/` is conformance-only |
| eTIMS live numbering source (KRA) | NOT STARTED | `src/domain/consent/etims.ts` takes an injected `sequenceSource` |
| Communications providers (SMS/WhatsApp/email clients) | NOT STARTED | `src/domain/communications/provider.ts` `simulatedProvider` is the only provider |
| Webhook delivery workers | NOT STARTED | `src/domain/webhooks/attempts.ts` is pure planning |
| Background workers/schedulers (dunning, expiry, aging, GL reconciliation triggers) | NOT STARTED | no worker entrypoint in tree |
| Temporal (or any durable workflow runtime, SPEC §40) | NOT STARTED | no temporal config/code |
| Observability (metrics, traces, structured logs, dashboards) | NOT STARTED | kernel has only `onError` (`src/adapters/http/server.ts`) |
| Docker/Terraform/Helm, environments | NOT STARTED | zero deployment artifacts in tree |
| OpenAPI spec + SDKs | NOT STARTED | no `openapi/` dir; `RouteRecord` is the de-facto contract |
| Rate limiting, TLS, secret management, dependency scanning | NOT STARTED | audit §5.2 |
| Multi-tenant store isolation for receivables/payments (org_id at rest) | NOT STARTED | process-global note in `src/adapters/http/routes/receivables.ts` header |

---

## 3. Wave history summary (details in [docs/BACKLOG.md](BACKLOG.md))

| Wave | Theme | PRs | Suite after merge |
|---|---|---|---|
| 1 | Fund truth: receivables, payments+reconciliation, adjustments | #11 #12 #13 | 283 |
| 2 | Allocation engine, event catalog+outbox, late fees+plans, consent/eTIMS | #14 #15 #16 #17 | 607 |
| 3 | Collections ops: cases, FX, ledger, promises+dunning, disputes, links, comms | #27 #28 #29 #30 #31 #32 #33 | 1044 |
| 4 | Intelligence: scoring, projections, behavior, Daraja conformance | #38 #39 #40 #45 | 1439 |
| 5 | Agent platform: policy, NBA, memory, agent capabilities | #41 #42 #43 #44 | 1959 |
| 6 | Platform services: auth&RBAC, webhooks, cross-border | #49 #50 #51 | 2174 |
| 7 | Governance+transport: approvals, audit, USSD, HTTP kernel | #56 #57 #58 #59 | 2531 |
| 8 | Transport completion+persistence: route mounts, file-backed AuthStore | #62 #63 | 2665 |

Every merge was squash-merge of a PR that closed its tracked issue; since wave 3 the
verification gate has been the local typecheck+suite (see the BLOCKED row above for why).

---

## 4. How to reproduce the gates

```bash
npm ci
npm run typecheck          # exit 0
npx vitest run             # Test Files 114 passed (114); Tests 2665 passed (2665)
```

Docs-only audit files (this file, [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md),
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md), [DECISIONS.md](DECISIONS.md)) do not touch `src/`;
the suite was re-run after their addition as proof.

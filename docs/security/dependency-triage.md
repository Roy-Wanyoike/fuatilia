# Dependency vulnerability triage — govulncheck + npm audit (issue #148)

Status: living document. Baseline commit for every cited path: `cd5c6df`
(main, wave-11, pre-remediation); remediation + re-scan on this branch
(`1d0fdf3` script/evidence → `481e536` upgrades → this commit). Any cited
path that stops existing makes this document wrong — re-verify paths on
every revision, same discipline as [threat model](./threat-model.md) §1.

Related: [threat model](./threat-model.md) (trust boundaries B1–B6 —
dependency risk is the supply-chain counterpart that cuts across all of
them) · [secrets runbook](./secrets.md) (§CI policy — evidence files
committed here contain scanner output only, no credentials) ·
`docs/PRODUCTION_AUDIT.md` §5.2 (the audit finding that spawned #148).

---

## 1. Scope, method, reproducibility

Three surfaces, three scanners, raw outputs committed under
`scripts/security/evidence/` (baseline stage `before`, post-remediation
stage `after`):

| Surface | Scanner | Scan level | Evidence |
| --- | --- | --- | --- |
| `backend-go/` | govulncheck v1.8.0 (DB vuln.go.dev, last modified 2026-09-10) | symbol (source) | `backend-go-govulncheck-{before,after}.{txt,json}` |
| repo root (TS domain core: `pg`, test tooling) | npm audit (npm 11.17.0, GitHub advisory DB) | lockfile | `root-npm-audit-{before,after}.json` |
| `frontend/` (Next.js web console) | npm audit | lockfile | `frontend-npm-audit-{before,after}.json` |

Reproduce / re-collect (CI-reusable; no workflow edits in this lane):

```sh
scripts/security/scan-dependencies.sh <stage>           # collect evidence
scripts/security/scan-dependencies.sh <stage> --strict  # exit 2 if ANY scanner reports findings
```

Scanner exit codes are normalized by the collector: findings are expected
(govulncheck 3, npm audit 1) and recorded, not swallowed; only a scanner
that cannot run fails the collection.

**Severity labeling.** npm audit advisories carry GitHub severity labels
(critical/high/moderate/low) — used verbatim. govulncheck does **not**
emit CVSS; for Go findings we classify by impact family from the advisory
summary: XSS / auth-bypass / cert-validation-bypass → **High**;
DoS / parser complexity / info-leak → **Moderate**; platform-limited or
test-only reachability → **Low**. The label is triage metadata, not a
claim of measured exploitability — the exploitability column is the load-
bearing judgment.

## 2. Summary

| Surface | Before | After | Residual |
| --- | --- | --- | --- |
| backend-go | **24 symbol-level** stdlib findings (govulncheck, go1.26.0 std) + 12 module-level | **0 symbol-level, 0 import-level** | 1 module-level advisory with **no fixed version** (§3.3, accepted-with-reason) |
| frontend | 5 packages: 3 **critical** (next RCE), 4 **high** (next ×~13 advisories, postcss, sharp), 2 moderate (vitest) | **0 critical, 0 high** | 2 moderate entries, one advisory (vitest, §4, tracked) |
| root | 0 | 0 | none |

Every HIGH/CRITICAL has an explicit disposition below (§3.1, §4.1–4.3).
No test was weakened, skipped or tightened to make gates pass; all gates
re-run green after the upgrades (§6).

## 3. backend-go — govulncheck

Baseline: `go.mod` declared `go 1.26.0` with no `toolchain` pin, so
`GOTOOLCHAIN=auto` builds against whatever std the local go ships
(go1.26.0 in this environment). All 24 symbol-level findings are in the
**standard library**, all fixed on the go1.26 patch line (≤ 1.26.6).

### 3.1 Symbol-level stdlib findings (24) — disposition: UPGRADE (toolchain pin `go1.26.8`)

Exploitability key — where the traced call path lands in this codebase:

- **B4/B5 (API edges)**: `cmd/api` `ListenAndServe` — operator dashboard
  auth, rate-limit/headers surface (threat model §5, §6).
- **B2 (webhook delivery, outbound TLS)**: `internal/webhooks/transport.go`
  `HTTPTransport.Deliver` — signed POSTs to receivers.
- **B1 (Daraja, outbound TLS)**: `internal/daraja/client.go` callbacks/STK.
- **relay**: `cmd/worker` NATS connect (event backbone).
- **test-only**: reachable only through `internal/infra/pgtest`.

| Finding | Stdlib pkg | Fixed in | Class | Reachable via (representative trace) | Exploitability in THIS codebase |
| --- | --- | --- | --- | --- | --- |
| GO-2026-6218 | net/url | 1.26.6 | DoS (quadratic `resolvePath`) | webhooks `Deliver` → `http.Client.Do` → `URL.Parse` | Unauthenticated URL parsing on B2 outbound + B4/B5 inbound; CPU exhaustion. Moderate risk |
| GO-2026-6091 | html/template | 1.26.6 | XSS (JS regexp context) | `cmd/api` → `template.Execute` | Server-rendered output in cmd/api; injected content could script. High |
| GO-2026-6090 | crypto/tls | 1.26.6 | DoS (post-handshake msg flood) | worker NATS, cmd/api, webhooks `io.Copy` → `tls.Conn` | B1/B2 TLS sessions are long-lived; handshakes attacker-influenced only via MITM. Moderate |
| GO-2026-6089 | net/http | 1.26.6 | DoS (HTTP/2 ReadHeaderTimeout) | `cmd/api` `ListenAndServe` | Public B5 edge — slowloris-class. Moderate |
| GO-2026-6088 | encoding/xml | 1.26.6 | DoS (recursion) | authstore `ActiveRulesForUser` → pgx `Scan` → `xml.Unmarshal` | XML arrives from our own PostgreSQL rows, not the wire — needs DB write access first. Low |
| GO-2026-5972 | encoding/asn1 | 1.26.6 | DoS (recursion) | pgtest → `asn1.Unmarshal` | Test-only path. Low |
| GO-2026-5856 | crypto/tls | 1.26.5 | Info leak (ECH) | B1/B2 outbound TLS | Privacy leak on ECH-negotiated conns. Moderate |
| GO-2026-5039 | net/textproto | 1.26.4 | Log injection (unescaped input in errors) | observability middleware → `ReadMIMEHeader` | Attacker-controlled headers echoed into error strings → log forging. Moderate |
| GO-2026-5037 | crypto/x509 | 1.26.4 | DoS (hostname parse) | webhooks `io.Copy` → cert `Verify`/`VerifyHostname` | Outbound TLS to B1/B2 receivers. Moderate |
| GO-2026-5026 | net/http | 1.26.6 | DoS (punycode labels) | webhooks `Deliver` → `http.Client.Do` | Outbound B2. Moderate |
| GO-2026-4982 | html/template | 1.26.3 | XSS (meta content URL) | `cmd/api` `template.Execute` | As 6091. High |
| GO-2026-4980 | html/template | 1.26.3 | XSS (escaper bypass) | `cmd/api` `template.Execute` | As 6091. High |
| GO-2026-4971 | net | 1.26.3 | DoS (NUL-byte panic, **Windows only**) | NATS dial, pgtest dial | Production is Linux containers (`Dockerfile` golang/alpine) — not exploitable here. Low |
| GO-2026-4947 | crypto/x509 | 1.26.2 | DoS (chain building) | outbound TLS (B1/B2) | Moderate |
| GO-2026-4946 | crypto/x509 | 1.26.2 | DoS (policy validation) | outbound TLS (B1/B2) | Moderate |
| GO-2026-4918 | net/http | 1.26.3 | DoS (HTTP/2 infinite loop) | `cmd/api` `ListenAndServe` | Public B5 edge, unauthenticated, persistent hang. Moderate (DoS family) but operationally severe |
| GO-2026-4870 | crypto/tls | 1.26.2 | DoS (KeyUpdate stall) | B1/B2 TLS | Unauthenticated record stalls conn. Moderate |
| GO-2026-4866 | crypto/x509 | 1.26.2 | **Auth bypass** (case-sensitive name constraints) | outbound cert verification (B1/B2, NATS) | A MITM could craft a cert we wrongly accept for Daraja/webhook/NATS endpoints. High |
| GO-2026-4865 | html/template | 1.26.2 | XSS (JsBraceDepth) | `cmd/api` `template.Execute` | As 6091. High |
| GO-2026-4603 | html/template | 1.26.1 | XSS (meta content URLs) | `cmd/api` `template.Execute` | As 6091. High |
| GO-2026-4602 | os | 1.26.1 | Sandbox escape (`os.Root` `FileInfo`) | os.Root usage in cmd/worker | File paths are ours, not attacker-controlled; class is High, exploitability here Low |
| GO-2026-4601 | net/url | 1.26.1 | Parsing confusion (IPv6 literals) | `URL.Parse` on outbound paths | Host-allowlist confusion potential on B2 endpoints. Moderate |
| GO-2026-4600 | crypto/x509 | 1.26.1 | DoS (panic, malformed certs) | outbound TLS verification | Malicious/misissued receiver cert. Moderate |
| GO-2026-4599 | crypto/x509 | 1.26.1 | **Cert validation bypass** (email constraints) | outbound TLS verification | As 4866 — wrong cert accepted on B1/B2. High |

**Disposition: UPGRADED.** `backend-go/go.mod` now pins
`toolchain go1.26.8` (current patch release, ≥ every `Fixed in` above;
zero code/API changes — the pin makes the *minimum* patched std explicit
for every builder and scanner instead of leaving std to the ambient local
go). Verified by the after-scan (DB 2026-09-10): **"Your code is affected
by 0 vulnerabilities"**, 0 import-level, config `go_version: go1.26.8`.

### 3.2 Module-level findings cleared (11)

Findings on the require/import graph where no symbol is called — still
worth clearing because "not called today" is one refactor away from
"called":

- **GO-2026-6354 / GO-2026-6355** (`golang.org/x/crypto/ssh`, DoS on
  deadlocked channels, fixed 0.56.0) → **UPGRADED** `x/crypto
  v0.55.0 → v0.57.0` (required transitively by pgx SCRAM, NATS, OTLP).
- **GO-2026-5942** (`x/net/dnsmessage` parsing panic, floor 0.56.0) →
  cleared: standalone `x/net` was already v0.58.0; the flagged copy is the
  one **vendored into the stdlib**, so the `go1.26.8` pin is the fix.
- **GO-2026-4864, 4869, 4970, 4976, 4977, 4981, 4986, 5038** (stdlib: os
  TOCTOU/root-escape, archive/tar allocation, ReverseProxy query
  forwarding, net/mail quadratic ×2, net CNAME crash, mime quadratic) →
  cleared by the same `go1.26.8` pin (fixed ≤ 1.26.6 on the go1.26 line).
- Consequential floors from the `x/crypto` bump, riding along:
  `x/sync v0.22.0→v0.23.0`, `x/sys v0.47.0→v0.48.0`, `x/text
  v0.41.0→v0.42.0` (no advisories of their own at these versions).

### 3.3 Remaining finding — disposition: ACCEPT-WITH-REASON + track

**GO-2026-5932 — "The golang.org/x/crypto/openpgp package is
unmaintained, unsafe by design, and has known security issues."**

- Affected path: `golang.org/x/crypto/openpgp` (submodule of the required
  `x/crypto`); **no fixed version exists** — the advisory *is* the
  deprecation.
- Exploitability in THIS codebase: **none reachable.** `grep -rn openpgp
  backend-go/ --include='*.go'` → no hits; the symbol-level scan shows no
  call path; nothing imports the package directly or transitively.
- Reason to accept rather than act: there is no upgrade target — `x/crypto`
  cannot be "fixed", only avoided. Removing `x/crypto` outright would break
  pgx (SCRAM auth), NATS and OTLP, i.e. it is not a real option; the
  vulnerability lives in a sibling package we do not import.
- Track: the after-scan keeps this at exactly 1 module-level finding. If a
  future dependency starts importing `x/crypto/openpgp`, the count grows
  past 1 and that is the tripwire to act (replace the dep or vendor a
  maintained openpgp implementation) **before** merging. Re-checked every
  scan cycle (§7).

## 4. frontend — npm audit

Baseline: next pinned `15.5.4` (exact), postcss devDep `^8.4.49`, sharp
`0.35.4-rc.0` (via next), vitest `^3.0.5`.

### 4.1 next — disposition: UPGRADED `15.5.4 → 15.5.25` (exact pin, non-major)

- **Severity: CRITICAL ×3** — unauthenticated RCE: React flight protocol
  (GHSA-9qr9-h5gf-34mp), Windows-hosted servers (GHSA-p293-qw3h-jr36),
  Image Optimization API with AVIF (GHSA-2xp9-vwfh-vxw4).
- **HIGH ×13** — middleware/proxy bypass ×4 (GHSA-26hh-7cqf-hhc6,
  GHSA-267c-6grr-h53f, GHSA-492v-c6pp-mqqv, GHSA-36qx-fr4f-26g5), SSRF ×3
  (GHSA-89xv-2m56-2m9x, GHSA-c4j6-fc7j-m34r, GHSA-p9j2-gv94-2wf4), DoS ×6
  (Server Components, connection exhaustion, Server Actions).
- Plus 13 moderate / 2 low (cache poisoning, request smuggling, source
  disclosure, image-cache exhaustion).
- Affected path: the entire Next.js server surface — the operator
  dashboard (threat model **B4**) and portal BFF (**B3**) are served by
  it; this is the most exposed dependency in the repo.
- Exploitability in THIS codebase: middleware-bypass and flight-protocol
  RCE advisories apply to App Router deployments exactly like ours —
  directly reachable pre-auth where the middleware gates sign-in
  (`frontend/src/middleware.ts`, dashboard redirect lane) and where
  `next/image` runs. The Windows-hosted RCE (GHSA-p293) is not reachable
  on our Linux/container deployment (frontend/Dockerfile,
  node:22-alpine) but is still critical-tagged and cleared by the same
  upgrade.
- `15.5.25` ≥ every fixed-in range above (max 15.5.24). Exact-pin
  convention kept (`"next": "15.5.25"`).

### 4.2 sharp (via next) — disposition: UPGRADED (lifted by the next bump)

- **Severity: HIGH ×2** — libvips CVE-2026-33327/-33328… (GHSA-f88m-g3jw-
  g9cj), libheif GHSA-g89c-p67h-r497/GHSA-2jg2-4ch7-h545 (GHSA-rgj7-g3m4-
  5g8c); baseline tree held `0.35.4-rc.0`.
- Affected path: image decoding inside `next/image` optimization —
  parses attacker-influenceable image bytes on the B3/B4 surfaces.
- Exploitability: memory-safety bugs in native decoders reachable by any
  user who can submit an optimized image URL. Real exposure.
- After: `sharp 0.35.4` (final > rc) — both advisories out of range.

### 4.3 postcss — disposition: UPGRADED (direct dep + `overrides` pin)

- **Severity: HIGH ×2** — arbitrary file read via attacker-controlled
  source maps (GHSA-6g55-p6wh-862q), path traversal in previous-source-map
  auto-loading (GHSA-r28c-9q8g-f849); plus moderate ×2 (GHSA-fxqj-rqcc-
  2cmp incomplete-fix follow-up, GHSA-qx2v-qp2m-jg93 `</style>` XSS in
  stringify output).
- Affected path: `frontend` build pipeline (Tailwind/PostCSS) **and**
  next's transitive postcss.
- Exploitability: build-time, requires attacker-controlled CSS/source-map
  content in the repo build inputs — low for this codebase — but the
  advisory class (arbitrary file read) earns HIGH and the fix is free.
- Change: devDep `postcss ^8.4.49 → ^8.5.23` **plus** `"overrides":
  { "postcss": "$postcss" }` so every transitive copy (including next's)
  resolves to the patched line; installed tree verifies 8.5.28.

### 4.4 vitest / @vitest/mocker — disposition: TRACK (explicit follow-up, not silently accepted)

- **Severity: MODERATE** (below the HIGH/CRITICAL mandatory-disposition
  bar, documented anyway) — GHSA-82fw-gwwq-j7x9: path traversal /
  arbitrary file read via `@vitest/mocker` redirect mock (CWE-22, CVSS
  5.9); range `>=2.1.0 <4.1.11`; fix = vitest **5.0.0, semver-major**.
- Affected path: `frontend` devDependencies only — vitest never ships in
  the production bundle (`next build` output contains no vitest).
- Exploitability: requires running tests against attacker-controlled mock
  configuration — a developer-machine risk, not a production surface.
- Why not upgraded now: the non-major fix does not exist; 3→5 is a major
  migration across 42 test files / 388 tests, and the issue's hard rule
  is "no fixes that break gates". The root workspace already runs vitest
  5 (root audit clean), so the migration has an in-repo reference.
- Tracked: fold into the Dependabot majors batch already deferred to
  post-wave review (vitest 5, next 16, react 19.2.8, zod 4,
  @vitejs/plugin-react 6 — worklog wave-11, task 1). Do not re-flag this
  as unhandled: it is a known, reasoned deferral.

## 5. repo root (TS domain core) — clean

`pg 8.23.0` (exact), `vitest ^5.0.0`, `typescript ^7.0.2`, `@types/pg` —
**0 vulnerabilities before and after** (14 prod / 86 dev deps). No action.

## 6. Gates after remediation (all green, this branch)

| Gate | Command | Result |
| --- | --- | --- |
| Go format/vet | `gofmt -l .` / `go vet ./...` (backend-go) | clean / clean |
| Go tests | `FUATILIA_TEST_PGBIN=/home/z/tools/pg164/bin go test ./... -race` | ok — auth, daraja, infra, infra/pgtest, observability, outbox, scheduler, transport, webhooks, idempotency, money |
| Root typecheck | `npx tsc --noEmit` | clean |
| Root tests | `FUATILIA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test npx vitest run` | 138 files / 3088 tests passed |
| Frontend typecheck | `npm run typecheck` | clean |
| Frontend tests | `npx vitest run` | 42 files / 388 tests passed |
| Frontend build | `npm run build` | succeeded (next 15.5.25) |

No test was modified, skipped or weakened in this lane; the only Go
source-line change is none (toolchain pin lives in go.mod). The
`pgtest.go` migration-count bump (14→15) already on main is *not* part of
this lane.

## 7. Residual risk & cadence

- **Re-scan triggers**: any PR touching `backend-go/go.mod`,
  `**/package-lock.json`, or `frontend/package.json` runs
  `scripts/security/scan-dependencies.sh ci --strict` locally; monthly
  full re-scan regardless (advisory DB drifts daily — db_last_modified is
  stamped in every evidence file).
- **CI wiring** is deliberately **not** in this lane (workflows are owned
  elsewhere, per issue #148 scope): the script is the integration point —
  `--strict` exits 2 on any finding for a blocking workflow.
- **GO-2026-5932** (openpgp, unfixed): accepted, tripwired via the
  module-level count (§3.3).
- **vitest 5 migration**: tracked (§4.4), lands with the deferred majors
  batch.
- **govulncheck severity honesty**: symbol-level ≠ exploited; module-level
  ≠ safe. Both are recorded; the disposition is what carries the
  decision.

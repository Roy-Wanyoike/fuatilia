# Changelog

All notable changes to **Fuatilia** — AI-native receivables intelligence & collections
infrastructure for Africa — are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) under the
**0.x pre-GA policy** defined in [docs/RELEASE.md](docs/RELEASE.md) (MINOR bump per
delivery wave while pre-GA; PATCH for fix-only cut-downs).

> **Provenance note (2026-09-10).** This changelog was reconstructed from the merged-PR
> record (`gh pr list --state merged`, PRs #11–#157) and the wave history in
> [docs/BACKLOG.md](docs/BACKLOG.md) / [docs/ENGINEERING_STATUS.md](docs/ENGINEERING_STATUS.md).
> **Every merged PR appears in exactly one entry below, with its correct type.** No git
> tags existed before this point; version numbers map 1:1 to the documented delivery
> waves, and each version header links to the exact `main` commit that closed the wave.
> Tag backfill instructions: [docs/RELEASE.md](docs/RELEASE.md) §4.

## [Unreleased]

Nothing yet — changes merged to `main` after v0.12.0 are listed here at cut time.

## [v0.12.0] — Wave 11c (hardening + comms rails) — 2026-09-10

### Added

- Email provider adapter — SMTP, idempotent sends, redaction-safe metadata (#152)
- WhatsApp Cloud API provider adapter — template sends, delivery receipts (#155)
- Collector session login UI — tokenized sign-in for the dashboard (#153)
- Daraja K1 wire parity, error taxonomy, credential hygiene — completes the production client surface (#156)
- Transport rate limiting + security headers middleware (#157)
- Full local compose stack — PG, NATS, backend-go, frontend + Makefile gate (#154)

### Fixed

- CI workflows repaired — PG service wiring, version pins, manual dispatch; billing blocker documented (#150)
- pgtest binary discovery — fix broken default, align env names with TS+CI (#151)

## [v0.11.0] — Wave 11 (production wave 3: kernel, persistence, rails, execution) — 2026-09-08 → 2026-09-10

### Added

- Go /v1 API kernel serving the mounted surface over PostgreSQL (#82)
- PGAuthStore + PGResourceStore sync facades over PostgreSQL (#83)
- Production Daraja REST client in Go (#97)
- Production SMS provider adapter — Africa's Talking / Twilio-compatible (#112)
- M-Pesa STK-push as a policy-gated collections execution action (#113)
- CSV invoice import + QuickBooks/Zoho Books mapping adapter (#116)
- PesaLink / bank-statement reconciliation adapter (#118)
- Go webhook delivery worker — HMAC-signed at-least-once execution of the attempt ladder (#125)
- Self-service debtor portal — tokenized balance, invoices, statements (#124)

### Fixed

- CI repair — corrupted triggers, PG-backed specs + frontend in CI, supply-chain scanning (#94)
- Land the drain-spin repairs for the PG adapters (#111)
- Land the drain-spin repairs for the PG adapters — corrective to #83's merge state (#110)
- Declare `*.css` module for TS 7's side-effect import check (#115)

### Changed

- Bump typescript from 5.9.3 to 7.0.2 (#104)
- Bump typescript from 5.9.3 to 7.0.2 in /frontend (#107)
- Bump vitest from 3.2.7 to 5.0.0 (#106)
- Bump tailwindcss from 3.4.19 to 4.3.3 in /frontend (#108)
- Bump jsdom from 25.0.1 to 30.0.1 in /frontend (#105)
- Bump pg from 8.13.1 to 8.23.0 (#102)
- Bump @testing-library/jest-dom from 6.9.1 to 7.0.1 in /frontend (#101)
- Bump autoprefixer from 10.5.4 to 10.5.5 in /frontend (#103)
- Bump actions/setup-go from 5 to 7 (#98)
- Bump actions/setup-node from 4 to 7 (#99)
- Bump actions/checkout from 4 to 7 (#100)

## [v0.10.0] — Wave 10 (production wave 2: event fabric, deploy, frontend) — 2026-09-04

### Added

- Transactional outbox relay to NATS JetStream (#78)
- Containers, compose stack, environment contract (#77)
- Next.js frontend foundation + Collections Command Center read path (#79)
- Market research docs — market analysis, product gaps, investor brief, wave-12 pipeline (#81)

## [v0.9.0] — Wave 9 (production wave 1: Go core, schema, contract) — 2026-09-04

### Added

- Go production core — `pkg/money` + `pkg/idempotency` with TS conformance suite (P0) (#70)
- PostgreSQL financial schema — migrations encoding R1–R10 + real local validation (P0) (#71)
- OpenAPI 3.1 contract for the mounted /v1 surface (P0) (#69)
- Production audit + roadmap + engineering status docs (P0) (#68)

## [v0.8.0] — Wave 8 (transport completion + first persistence adapter) — 2026-09-04

### Added

- Resource route mounts (F31) (#62)
- File-backed auth persistence (F32) (#63)

## [v0.7.0] — Wave 7 (governance + transport) — 2026-09-04

### Added

- Maker-checker approval workflows (SPEC §36) (#56)
- Unified append-only audit trail (SPEC §37) (#57)
- USSD session workflows for low-tech channels (SPEC §31) (#58)
- HTTP transport kernel — /v1 router, auth middleware, error mapping (SPEC §38) (#59)

## [v0.6.0] — Wave 6 (platform services) — 2026-09-03

### Added

- Auth & RBAC domain core — users, roles, permission matrix, API keys, sessions (#49)
- Webhook subscriptions, signing contract, delivery lifecycle — developer platform domain (#50)
- Cross-border corridors, FX quotes with expiry, transfer intents, fee schedule (#51)

## [v0.5.0] — Wave 5 (agent-ready platform) — 2026-09-03

### Added

- Policy engine — deterministic action governance, allow/deny/require-approval (#41)
- Next-best-action engine — explainable ranking + policy filter + feedback (#42)
- Explainable financial memory — event-derived features with evidence (#43)
- Agent capability queries — financial state, priorities, recommendations with evidence (#44)

## [v0.4.0] — Wave 4 (intelligence) — 2026-09-03

### Added

- Collections priority scoring + recommendation feedback loop (H7) (#38)
- Segment strategies + reporting projections (SPEC §19/§20/§66) (#39)
- Customer behavior profiles + explainable anomaly detection (SPEC §4/§24) (#40)
- Daraja adapter conformance suite — callback fixtures + at-least-once replay (#45)

## [v0.3.0] — Wave 3 (collections ops) — 2026-09-03

### Added

- Dispute lifecycle + collections pause policy (SPEC §29) (#27)
- FX snapshots + realized gain/loss postings (H2, R10) (#28)
- Posting matrix + GL reconciliation job (K5, R4) (#29)
- Secure payment links with lifecycle + idempotent redemption (#30)
- Collections cases + actions + exclusivity invariant (H6, R8) (#31)
- Conversations, versioned templates, consent-gated sends (K2) (#32)
- Promise-to-pay lifecycle + consent-checked dunning orchestration (K2) (#33)

## [v0.2.0] — Wave 2 (fund truth, part 2) — 2026-09-02

### Added

- DPA 2019 consent registry + WhatsApp opt-in + eTIMS numbering (K2–K4) (#14)
- Allocation strategy chain FIFO/explicit/pro-rata on `Money.allocate` (H3, R1, R2) (#15)
- Typed event catalog (27 events) + outbox contract, envelope + versioning (#16)
- Late fee accrual + PaymentPlan schedule engine (H4, H5) (#17)

## [v0.1.0] — Wave 1 (fund truth core) — 2026-09-02

### Added

- Receivables core entity, lifecycle states, aging, write-off ownership (H1) (#12)
- Idempotent dual-path payments intake + reconciliation re-pointed to Payment (C5, C1) (#13)
- Adjustments — refunds, credit notes, customer credit balance (C2, C3, C4) (#11)

---

## Links

Historical versions were never tagged at the time; each link points at the exact `main`
commit that closed that wave (see [docs/RELEASE.md](docs/RELEASE.md) §4 for tag backfill).
Note: waves 4 and 5 interleaved on `main` (PRs #38–#45 merged alternately), so the v0.4.0
tree shows the state after #38–#40 while v0.5.0's tree includes all of #38–#45.

[Unreleased]: https://github.com/Roy-Wanyoike/fuatilia/compare/v0.12.0...HEAD
[v0.12.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/e60aca2
[v0.11.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/f8e237e
[v0.10.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/3b79e80
[v0.9.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/74d54ae
[v0.8.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/8be0d08
[v0.7.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/ab7ccbb
[v0.6.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/7b9bd24
[v0.5.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/3bcb842
[v0.4.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/b184f7b
[v0.3.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/b160590
[v0.2.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/f1d3d42
[v0.1.0]: https://github.com/Roy-Wanyoike/fuatilia/tree/c896c55

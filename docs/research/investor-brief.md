# INVESTOR BRIEF — Fuatilia: the AI-native receivables intelligence & collections infrastructure for Africa

> Task 11-c deliverable. Every product claim is verifiable in the repository; every market figure is
> labeled per [market-analysis.md](market-analysis.md) sourcing levels. Written to be read in five
> minutes, checked in five more.

---

## 1. The problem

African businesses don't fail because nobody owes them money — they fail because collecting is manual,
error-prone and blind. In Kenyan B2B, late payment is the default condition (one trade source reports
>60% of Kenyan SMEs face payment delays beyond 30 days [W, directional]); the SSA SME finance gap is
~US$331B [W], Kenya's MSME gap is measured in trillions of shillings [W], and the collection layer that
would keep businesses solvent — knowing **who owes, how much, when they'll pay, what to do next** — is a
spreadsheet, a notebook and someone's memory. The money moves on M-Pesa (91% mobile-money penetration,
47.7M active subscriptions, June 2025 [W]); the *knowledge* of the money moves nowhere.

Global AR-automation (HighRadius, Versapay, Chaser, Kolleno — a US$3.8–4.8B market growing 11–13% CAGR
[W]) assumes bank rails, ERPs and email. None of that describes an Kenyan SME, SACCO, school, hospital
or micro-lender. The category winner for this market has to be built for M-Pesa, WhatsApp, USSD and
DPA-2019 — from the ledger up.

## 2. Why now

1. **Rails are universal.** 91% mobile-money penetration in Kenya (June 2025) [W]; M-Pesa 51M+ customers
   across 7 markets [W]; Daraja and PesaLink give programmatic payment truth.
2. **The credit gap forces better collections.** US$331B SSA SME finance gap [W]; every lender and
   supplier is under pressure to collect better, not just lend more.
3. **Regulation creates the compliance cliff.** eTIMS mandatory e-invoicing [W]; DPA 2019 enforcement and
   the ODPC regime [W]; digital credit entering a regulated phase [W]. Compliance-by-design becomes a
   procurement requirement, not a nice-to-have.
4. **AI expectations flipped.** 2026 buyers see "agentic AI for collections" in global products [W] —
   but autonomous money-adjacent AI is only credible on governance rails that incumbents bolt on and
   African tools lack entirely. Fuatilia was built with those rails first.
5. **The engineering risk is retired.** 32/32 domain features merged, 2,665 tests green, Go production
   core conformance-proven, PostgreSQL schema with invariants-as-DDL proven on a real cluster, OpenAPI
   3.1 contract, crash-safe outbox relay, deploy foundation, frontend foundation [repo docs].

## 3. The product wedge

Enter through the sharpest pain, expand across the receivables graph:

1. **Collections Command Center** (shipped read path): the four questions answered on real data —
   receivables, aging, cases, payments, reconciliation exceptions — with strict REAL/PREDICTION/SIMULATION
   labeling so operators never confuse fact with forecast.
2. **Consent-gated automated collections**: dunning ladders, promises, disputes, payment links across
   SMS/WhatsApp/USSD — every automated send consent-checked (`DUNNING_CONSENT_REQUIRED` is a tested
   refusal, not a policy memo).
3. **AI decision surfaces**: next-best-action with action/benefit/confidence/reason/evidence/policy
   status; collections priority scoring with a feedback loop; explainable customer financial memory where
   every claim carries `computedFrom` event anchors; Cash Recovery Simulator and a Collections Digital
   Twin — predictions and simulations always labeled, never balances.
4. **Ledger truth underneath**: every shilling reconciled back through idempotent M-Pesa intake,
   exact-rational allocation (no cent created or destroyed — R1/R2 as tested invariants), append-only
   adjustments, GL reconciliation, hash-chained audit.

## 4. Architecture as moat

- **Ledger-first financial truth.** Payments, allocations, refunds and credit notes are append-only
  facts; corrections are reversing entries. PostgreSQL is the only financial source of truth (ADR-0002);
  R1–R10 invariants are enforced as *tests* in the domain and as *DDL triggers* in the schema, proven on
  a real PostgreSQL 16 cluster (25/25 assertions green).
- **Conformance-proven Go production port.** The TypeScript domain is the executable behavioral
  specification (2,665 table-driven tests); the Go core must reproduce TS outputs fixture-for-fixture —
  money semantics and idempotency registry already conformance-proven (ADR-0001). Two independent
  implementations agreeing on money math is an anti-regression moat competitors can't shortcut.
- **Transactional-outbox event fabric.** State changes and events commit atomically; a Go relay drains to
  NATS JetStream at-least-once with per-org ordering, dedup, poison DLQ and replay — proven crash-safe
  against real PostgreSQL and embedded JetStream, with fault injection (ADR-0003).
- **AI-native decisioning with human gates.** ADR-0005: *no AI/ML component may write financial state,
  ever.* The only execution path is recommendation → policy engine (fail-closed, machine-readable
  refusals) → maker-checker approval quorum → deterministic lane → audit record. The intelligence layer
  is read-only by construction. This is the architecture that makes "autonomous collections" sellable to
  a risk committee and survivable for a regulator.
- **Compliance in the domain, not bolted on.** DPA 2019 consent registry and DSAR lane, eTIMS numbering
  hooks, redaction pipeline, audited denials, org-scoped multi-tenancy enforced at the storage layer.

## 5. Defensibility

1. **Domain completeness is 10-person-years-shaped and test-pinned**: 32 features, 2,665 tests, 114
   suites — replicable only by paying the same invariant-first cost (the hard 60% is done here).
2. **Rail-native trust**: Daraja conformance suite (fixtures + at-least-once replay) and the idempotency
   tripwires mean Fuatilia *expects* duplicate callbacks and untrusted input — the failure mode that
   breaks generic AR tools in this market is a tested non-event here.
3. **Regulatory conversion**: every ODPC/KRA/CBK tightening raises competitors' cost more than ours —
   consent, DSAR, redaction, audit chain and eTIMS hooks are already domain invariants.
4. **Data flywheel**: every collection action feeds the feedback loop (scoring, NBA, behavior profiles);
   the memory graph per customer (cadence, promise reliability, channel preference, exposure) is a
   switching-cost asset and the raw material for a consented credit-scoring data product.
5. **Platform distribution**: webhooks + OpenAPI-derived SDKs + embedded "Collections powered by
   Fuatilia" turn partner SaaS (construction, ERP-adjacent, PSPs) into a sales channel — the VISION §6–7
   thesis.

## 6. KPI plan (what we instrument to prove traction)

| Stage | North-star | Supporting KPIs |
|---|---|---|
| Activation | First reconciled M-Pesa payment within 7 days of signup | time-to-first-invoice, CSV/import share, onboarding drop-off |
| Collections value | **Recovery-rate delta vs pre-Fuatilia baseline** (30/60/90-day cohorts) | DSO delta, promise-kept rate, dunning consent coverage, automated-action share |
| Intelligence quality | NBA acceptance rate + outcome uplift per accepted action | override rate, policy-block rate, feedback-loop volume, forecast error |
| Trust | Zero fund-truth incidents; audit-chain verification pass rate | R1/R2 violation alerts (target: 0), duplicate-callback tripwires handled, DLQ drain time |
| Revenue | Net revenue retention | ARPU, per-execution metering share, embedded-partner ARR, logo retention |
| Platform | Partner-embedded collections volume | webhook delivery success %, API usage per key, SDK adoption |

## 7. Verifiable repo evidence (what diligence can check today)

- **Tests**: `npm ci && npm run typecheck && npx vitest run` → **2,665/2,665 across 114 suites** (Node ≥22;
  repo README + ENGINEERING_STATUS.md reproduce the command).
- **Invariants**: `docs/07-invariants.md` (R1–R10); enforced twice — TS domain tests and PostgreSQL DDL
  (`bash db/validate.sh`: 25/25 assertions on a real cluster).
- **Go core**: `backend-go/` — money + idempotency conformance-tested against TS fixtures; outbox relay
  crash-safety tests with fault injection; `go vet`/race green.
- **Contract**: `api/openapi/fuatilia.v1.yaml` — OpenAPI 3.1, 22 operations ≡ 22 mounted routes
  (`scripts/validate_openapi.py` PASS); frontend error-code union pinned set-equal to the spec.
- **PR discipline**: every feature = one issue + one PR, squash-merged with `Closes #N`; wave history in
  docs/BACKLOG.md (607 → 1044 → 1959 → 2174 → 2531 → 2665 tests).
- **ADRs**: docs/DECISIONS.md ADR-0001..0005 — including ADR-0005's absolute rule that AI never mutates
  financial truth.
- **Honesty artifacts**: PRODUCTION_AUDIT.md (what does *not* run yet, with file-path evidence),
  ENGINEERING_STATUS.md (BLOCKED CI billing lock documented), frontend "dead-backend honesty" (no
  fabricated rows). Investors should expect a team that states limits precisely — that is the culture
  the artifacts show.

## 8. The ask-shaped summary

Fuatilia is a completed, invariant-dense financial domain engine with production foundations (Go core,
PostgreSQL truth, event fabric, OpenAPI contract, frontend), entering a market where payment rails are
universal, late payment is structural, regulation is tightening, and no competitor combines
ledger-grade truth + rail-native execution + governed AI. The capital question is not *can it be built*
(verified: it is built) but *how fast the pending integration seams* (Daraja production, comms providers,
remaining mounts, hosted deploy) *can be closed and sold through* — the wave-12 pipeline in
[product-gaps.md](product-gaps.md) is that plan, RICE-ordered.

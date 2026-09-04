# MARKET ANALYSIS — African receivables, collections & AR-automation landscape

> Task 11-c deliverable. Grounded in the audited product state (docs/BACKLOG.md, docs/PRODUCT_ROADMAP.md,
> docs/ENGINEERING_STATUS.md, docs/PRODUCTION_AUDIT.md). Every number is one of three sourcing levels:
> **[W]** web-sourced (query + date noted), **[K]** internal knowledge (well-established, no web confirmation),
> **[E]** explicit estimate (assumption chain shown). No invented statistics; where reports disagree, ranges are shown.

---

## 1. Scope and market structure

Fuatilia sells into the intersection of three markets that are usually served by different vendors:

1. **AR-automation / collections SaaS** (global): invoicing-to-cash workflow tools — reminders, dunning,
   cash application, promise tracking. Anchors: HighRadius, Billtrust, Versapay (enterprise), Chaser, Upflow,
   Invoiced, Kolleno (SMB/mid-market), plus native collections modules inside QuickBooks Online and Xero. [W]
2. **Trade-credit liquidity** (Africa): invoice factoring/discounting and supplier-financing players that
   monetize the *same pain* (late B2B payment) by buying the receivable instead of collecting it. [K]
3. **Kenya payment-rail-adjacent tooling**: M-Pesa/Daraja (STK push, C2B), PesaLink bulk transfers, USSD
   channels, payment links and PSP dashboards — the rails receivables tools must reconcile against. [W/K]

The structural fact that defines the opportunity: **African B2B commerce runs on informal trade credit with
no AR software layer.** Late payment is the normal condition of Kenyan B2B — one 2026 trade source reports
over 60% of Kenyan SMEs face payment delays beyond 30 days [W, single trade source, weak corroboration —
treat as directional], and the SSA SME finance gap is estimated at **US$331 billion** [W: MIT Sloan, Nov 2024,
IFC-derived]. Where global vendors assume credit cards, ACH and ERP integrations, Kenyan SMEs run on
M-Pesa statements, spreadsheets and WhatsApp threads. Nobody has built collections infrastructure for
*that* reality — which is exactly the wedge Fuatilia occupies.

### 1.1 Why the global AR-automation wave does not transfer

| Global assumption | Kenyan reality |
|---|---|
| Bank rails: ACH, SEPA, cards | M-Pesa C2B/STK push, PesaLink, cash; vague payment references, no payer-side memo discipline |
| ERP/QuickBooks/Xero as system of record | Spreadsheets and notebooks; ERP penetration is thin below mid-market [K] |
| Email is the collections channel | WhatsApp/SMS/USSD and voice; email is a mid-market channel at best [K] |
| Regulated debt collection is mature | Collections practice is unstandardized; DPA 2019 (2019) set the first binding data rules |
| Payments arrive matched | Reconciliation is manual; payers under-pay, over-pay and pay wrong invoices routinely |

This is why the honest competitive statement is: **global AR tools solve collections for businesses that
already have financial infrastructure; Fuatilia *is* the financial infrastructure for collections.**

---

## 2. Market sizing — TAM / SAM / SOM (all estimates, logic shown)

**Anchor market [W]**: global AR-automation market estimates cluster around **US$3.8–4.8B in 2025–2026**,
growing at **~11–13% CAGR** toward **US$13–16B by 2031–2035** (vendor market reports disagree on levels;
the range is the honest statement). One report projects the SME segment alone growing US$1.35B (2024) to
US$4.48B (~2034). Africa's share of these figures is negligible — which is the point: the market reports
measure software sold, not the receivables that exist.

### TAM — Kenya + East Africa receivables-operations software spend
**[E] Estimate chain (every step is an assumption, stated):**
- Kenya has ~1.5M licensed MSMEs [K, KNBS-class figure; treat as ±30%] plus ~5–10k mid-market firms with
  formal AR functions [E].
- Assume the *addressable* tier is: 20k formal AR teams (mid-market, micro-lenders, SACCOs, schools,
  hospitals, distributors, construction/subscription SMEs) [E] who could pay AR-operations SaaS.
- Assume blended achievable pricing of **US$150–600/month** — between a QuickBooks add-on (~US$20–50/mo
  global [W for Western pricing: Chaser £199–£899/mo, Kolleno US$650–1,245/user/mo]) and what Kenyan
  mid-market CFOs demonstrably pay for operational SaaS [K].
- TAM ≈ 20,000 × US$150–600/mo × 12 = **US$36M–144M ARR in Kenya alone**; East Africa (TZ, UG, RW, ZM
  corridors) roughly 2–3× Kenya → **TAM ≈ US$100M–400M ARR**. Compare: this is a *software-spend* TAM.
  The *economic* TAM is far larger: collections cost and working-capital drag on hundreds of billions in
  trade credit [E].

### SAM — consented, multi-channel, ledger-grade collections (Fuatilia's wedge)
**[E]** The subset that needs (a) M-Pesa-native reconciliation, (b) consent-gated automated follow-up
(DPA 2019 exposure), (c) collections case management and (d) auditability: micro-lenders, SACCOs,
distributors/wholesalers, schools/colleges, hospitals/clinics, subscription SMEs, B2B suppliers with
30–90 day terms. Assume 10–25% of the TAM tier → **US$10M–100M ARR** across Kenya + East Africa [E].

### SOM — 3-year Kenya wedge
**[E]** With founder-led sales + 2–3 embedded partners ("Collections powered by Fuatilia"), assume
300–800 accounts at an average **US$200–400/mo** (entry tier) plus per-execution metering →
**SOM ≈ US$1M–3.5M ARR by year 3**. This is deliberately modest: the platform economics arrive at P3/P4
(agentic collections + embedded/API distribution), not from seat licenses.

> All three numbers are estimates under stated assumptions — they are *for orientation*, not for
> publication. The defensible claim is qualitative: Kenya is the world's densest mobile-money market
> (91% mobile-money penetration, 47.7M active subscriptions, June 2025 [W]; M-Pesa serves 51M+ customers
> across 7 markets [W, Jun 2025]), with a KES-trillion-scale SME financing gap [W: ~KES 2.5T sector study;
> ~KES 3.3T 2026 press], and **no ledger-first, AI-native, consent-gated collections platform exists for it**.

---

## 3. Competitive matrix

Legend: **●** shipped strength · **◐** partial/planned (see product-gaps.md) · **○** absent ·
**n/a** not applicable to that model. Sources: vendor sites/pricing pages and comparison articles [W,
retrieved this session]; Fuatilia column audited against repo docs (0 fabrication).

| Capability | QuickBooks/Xero native | Chaser / Invoiced / Upflow | Kolleno (AI copilot) | HighRadius / Versapay / Billtrust | Factoring & invoice finance (Kenya) | M-Pesa/PSP dashboards & payment links | Digital lenders (M-Shwari/Fuliza/Tala-class) | **Fuatilia** |
|---|---|---|---|---|---|---|---|---|
| Invoicing / receivable lifecycle | ● (basic) | ◐ (sync from ERP) | ◐ | ● | ◐ (invoice purchase only) | ◐ (links) | n/a | ● (Invoice→Receivable split, plans, late fees) |
| Payment reconciliation to rail truth | ◐ (bank feeds) | ◐ | ◐ | ● (cash application) | ◐ | ● (their own rail only) | ● (their own loan book only) | ● **M-Pesa/Daraja-native, idempotent intake, match core** |
| Collections case management | ○ | ● | ● | ● | ○ | ○ | n/a | ● cases, actions, promises, disputes, R8 exclusivity |
| Multi-channel execution (SMS/WhatsApp/USSD) | ○ | ◐ (email-heavy) | ◐ (email/SMS) | ◐ | ○ | ◐ (SMS) | ● (SMS/USSD) | ◐ **USSD domain shipped; comms providers are the pending seam** |
| Payment links / plans as first-class | ◐ | ◐ | ◐ | ● | n/a | ● | n/a | ● bounded single/partial-use links, plan engine |
| AI decisioning with policy + approval gates | ◐ (2026 "AI agent" in QBO [W]) | ◐ | ● (copilot) | ● (agentic AI [W]) | ○ | ○ | ● (their underwriting) | ● **NBA + policy engine + maker-checker + audit chain** |
| Explainability (evidence refs per recommendation) | ○ | ○ | ◐ | ◐ | ○ | ○ | ○ | ● **every claim traceable to events** |
| Ledger-first fund truth (append-only, reversing entries) | ○ | ○ | ○ | ◐ | ● (their ledger) | ◐ | ● | ● **sub-ledger + GL reconciliation + hash-chained audit** |
| Consent & data-protection by design (DPA 2019 / GDPR-class) | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ | ● **consent registry, DSAR, redaction, K2 gates** |
| eTIMS numbering hooks (KRA) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● (domain-ready; live numbering = pending seam) |
| Cross-border corridors / multi-currency | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ◐ | ● domain (FX snapshots, corridors, fees); corridors = pending |
| Embedded / API-first platform (webhooks, SDKs) | ◐ | ◐ | ◐ | ● | ○ | ◐ | ○ | ● webhooks domain + OpenAPI 3.1 contract; SDKs = pending |
| Kenya/USSD/low-tech channel | ○ | ○ | ○ | ○ | ◐ | ◐ | ● | ● **USSD session machine + 5 flows shipped** |

**Read of the matrix:** the capability *combinations* are the moat, not single cells. Global AI-copilots
(Kolleno, HighRadius) have no M-Pesa truth and no DPA-2019-native consent model; local rails (M-Pesa
dashboards, digital lenders) have no ledger-grade AR domain and no multi-customer collections workflow;
factoring monetizes the receivable but does not *operate* collections. Fuatilia is the only column that is
strong across truth + execution + governance simultaneously — with the honest caveat that several
Fuatilia cells are domain-shipped but not yet runtime-wired (see product-gaps.md).

---

## 4. Buyer personas (who feels the pain)

### P1 — SME CFO / owner-operator (distributor, wholesaler, construction, subscription SME)
- 50–500 customers on trade credit; 30–90 day terms; collects via M-Pesa, cash, bank.
- Pain: cannot answer *who owes / how much / when will they pay / what next* without a spreadsheet
  marathon; write-offs are guesswork; eTIMS numbering pressure from KRA [W].
- Buys: cash-in visibility, automated follow-up that doesn't embarrass them, payment links that actually
  convert. Willing to pay US$50–300/mo [E]. Channel: founder-led sales, WhatsApp demos, accountant referrals.
- Kills deals: setup burden, per-seat pricing, anything that needs an ERP first.

### P2 — Head of collections / credit manager (mid-market, hospital, school chain, SACCO)
- Owns a book of 500–20,000 receivables and a team of collectors.
- Pain: no prioritization (collects by age, not by recoverability), no promise tracking, no dispute
  pause discipline, no audit trail when a customer or auditor challenges a collector.
- Buys: worklists, case management, consent-safe automation, effectiveness reporting. Willing to pay
  US$300–1,500/mo with seat expansion [E]. Channel: direct sales, fintech partnerships.

### P3 — Micro-lender / digital-credit ops lead (the sharpest wedge)
- Regulated (CBK digital credit providers), portfolio-based, high-frequency small loans via M-Pesa.
- Pain: collections are the business — repayment rates decide survival; contact strategies are
  SMS-blast-and-pray; regulator scrutiny (DPA 2019 + digital-credit regulations) is rising [W/K];
  they need consent records and explainable, auditable follow-up *now*.
- Buys: dunning ladders with consent gates, promise/plan handling, behavior profiles, priority scoring,
  reconciliation of M-Pesa repayments to loan accounts, webhook/API integration into their loan core.
  Willing to pay per-account or per-execution metering [E]. Channel: direct + API/embedded.

---

## 5. Regulatory context — why compliance-by-design is a moat

1. **Kenya DPA 2019** [W/K] — applies to any organization processing personal data of individuals in
   Kenya; registration with the ODPC is mandatory for controllers/processors above thresholds; consent
   must be demonstrable; data-subject rights (access, rectification, deletion) are enforceable. Collections
   *is* personal-data processing at scale. Fuatilia's consent registry, DSAR lane, redaction pipeline and
   consent-gated dunning (`DUNNING_CONSENT_REQUIRED` as a *tested domain refusal*) are architectural facts,
   not a compliance appendix.
2. **eTIMS (KRA electronic Tax Invoice Management System)** [W] — mandatory e-invoicing rollout enforced
   for Kenyan businesses (2024–2026 enforcement wave); invoice numbering and KRA visibility are now
   operational constraints on any AR platform. Fuatilia's eTIMS numbering hooks (`src/domain/consent/etims.ts`,
   sequence-source port) make invoice issuance KRA-compatible by design.
3. **CBK payment rails & digital-credit regulation** [W/K] — M-Pesa/Daraja is the de-facto rail; PesaLink
   covers bank-side transfers; CBK-licensed CRBs (TransUnion, Metropol, Creditinfo) and the digital-credit
   provider regime put collections conduct and data use under explicit oversight. A platform whose events
   are append-only, whose AI cannot move money (ADR-0005), and whose every action is audit-chained is the
   *shape* of what regulators will keep demanding.
4. **The moat mechanism**: compliance features are typically bolted on and shallow. Fuatilia's are
   domain invariants with tests (R1–R10, K1–K6 review findings, 2,665 tests [repo docs]) — a competitor
   cannot add "consent-gated, audit-chained, explainable collections" without rebuilding its domain core.
   As regulation tightens (ODPC enforcement, digital-credit conduct rules), the compliant-by-construction
   platform converts regulatory cost into competitor cost.

---

## 6. Why now

1. **Rails are ready**: 91% mobile-money penetration in Kenya (June 2025) [W]; M-Pesa as universal B2B and
   B2C payment substrate; Daraja APIs and PesaLink give programmatic money movement.
2. **The credit gap is the pressure**: US$331B SSA SME finance gap [W]; KES-trillion Kenya MSME gap [W] —
   lenders must underwrite *and collect* better; suppliers extending trade credit have no tooling.
3. **Enforcement creates urgency**: eTIMS is mandatory [W]; DPA 2019 enforcement is active [W]; digital
   credit is entering a regulated phase [W].
4. **AI maturity flipped the expectation**: 2026-era AR buyers see "AI copilot for collections" in global
   products [W]; agentic collections (HighRadius-class [W]) is mainstream language. But *autonomous money-
   adjacent AI requires exactly the governance rails Fuatilia already ships* — policy engine, approvals,
   audit chain — which incumbents treat as enterprise add-ons and African tools don't have at all.
5. **The build is de-risked**: 32/32 domain features merged, 2,665 tests, Go production core
   conformance-proven, PG schema with invariants-as-DDL, OpenAPI contract, outbox relay, deploy foundation,
   frontend foundation [repo docs]. Remaining work is integration and go-to-market, not invention.

---

## 7. Sourcing table (honesty ledger)

| Section | Level | Basis |
|---|---|---|
| §1 market structure | [W]+[K] | Web search this session (AR-automation comparisons, Kenya payment/SME sources); well-established regional structure from knowledge |
| §2 TAM/SAM/SOM | [E] | Full assumption chains above; anchor figures only from [W]/[K] sources |
| §2 anchors (91% penetration, 47.7M subs, M-Pesa 51M+, $331B gap, KES 2.5–3.3T gap, AR market $3.8–4.8B) | [W] | Web search results retrieved this session (report dates Jun 2024–Sep 2026 as shown in snippets); market-report figures vary by vendor — ranges given |
| §3 competitor matrix | [W]+[repo] | Vendor/comparison sources for global players; Fuatilia column from repo audit (docs/BACKLOG.md, docs/ENGINEERING_STATUS.md) |
| §4 personas | [K]+[E] | Constructed personas; pricing tolerances are estimates |
| §5 regulation | [W]+[K] | DPA 2019, eTIMS enforcement, CBK regime — web-confirmed; details from knowledge |
| §6 why now | mixed | Each bullet carries its own label |

Known weak spots, stated plainly: (1) the "60% of Kenyan SMEs face >30-day payment delays" figure comes
from a single trade article [W] — use directionally; (2) African factoring/embedded-finance names are
not individually profiled here (fragmented, mostly bespoke lenders) — the factoring *category* is the
competitor, not specific firms; (3) all SOM/pricing-tolerance numbers are estimates pending discovery
interviews — the correct next step is 20–30 persona interviews, not more desk research.

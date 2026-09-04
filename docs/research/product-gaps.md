# PRODUCT GAPS — planned-but-pending work, market-driven features, and the wave-12 pipeline

> Task 11-c deliverable. Section (a) is a doc-audited inventory of *already planned* pending work
> (cited). Section (b) is the market-driven gap analysis vs the competitive landscape in
> [market-analysis.md](market-analysis.md). All RICE scores are **relative estimates** (assumption
> labels below the table) — useful for ordering, not for publication as fact.

---

## (a) PENDING features already planned in the repo docs (cite-able, not invented)

### Directly tracked issues (open today)
| Item | Source | Evidence of pending state |
|---|---|---|
| **#72 — Go /v1 API kernel** (pgx-based vertical slice over PostgreSQL, OpenAPI parity test, R9 idempotency, R8 exclusivity, ledger in-tx) | docs/BACKLOG.md wave-10 closing note | "Still open (carried to wave 11): #72 Go /v1 API kernel"; deploy validator strict mode "goes green when #72's cmd/api lands" (docs/DEPLOY.md) |
| **#73 — PostgreSQL persistence adapters** (AuthStore/ResourceStore seams are synchronous; needs cache-first sync facade + async durable flusher) | docs/BACKLOG.md wave-10 closing note | "client.ts + schema-map.ts drafts are complete and reviewed, authstore.ts needs the redesign" |

### Planned in PRODUCT_ROADMAP.md phases (P0–P5)
| Pending capability | Phase | Cited acceptance anchor |
|---|---|---|
| Remaining /v1 resource mounts to SPEC §38 parity (customers, invoices, ledger, adjustments, links, promises, disputes, comms, webhooks) | P1 | PRODUCT_ROADMAP.md P1.1; ENGINEERING_STATUS.md "Remaining /v1 mounts — NOT STARTED" (22 mounted today) |
| **Daraja production adapter** (real C2B/STK, callback URL provisioning, sandbox-gated conformance) | P1 | PRODUCT_ROADMAP.md P1.3; `src/adapters/daraja/` is conformance-only (PRODUCTION_AUDIT.md §4) |
| **eTIMS live numbering** (sequence source bound to a PG `SELECT … FOR UPDATE` counter / KRA reservation) | P1 | PRODUCT_ROADMAP.md P1.4; `src/domain/consent/etims.ts` takes an injected `sequenceSource` |
| **Communications providers** (real SMS/WhatsApp/email clients behind `provider.ts`) | P1 | ENGINEERING_STATUS.md: `simulatedProvider` is the only provider |
| **Webhook delivery workers** (execute the pure attempt ladder with HMAC signing) | P1 | ENGINEERING_STATUS.md: `src/domain/webhooks/attempts.ts` is pure planning |
| **Background workers** (dunning executor, link expiry, aging triggers, GL reconciliation) on Temporal (ADR-0004) | P1 | PRODUCT_ROADMAP.md P1.5; no worker entrypoint outside Go relay |
| Edge security: TLS, rate limiting, secret manager, dependency scanning | P1 | PRODUCT_ROADMAP.md P1 security notes; PRODUCTION_AUDIT.md §5.2 |
| Observability: structured logs, outbox-lag/DLQ metrics, OpenTelemetry, SLO dashboards | P1 | PRODUCT_ROADMAP.md P1 observability section |
| **Event projection pipeline** (NATS → the ten memory fact types) + reconciliation confidence scoring + forecasts | P2 | PRODUCT_ROADMAP.md P2.1–P2.4; `src/domain/memory/README.md` caller-projection note |
| Model governance register; precision/recall evals before automated actions | P2 | PRODUCT_ROADMAP.md P2.5 + test strategy |
| **Agent execution API + copilot UX** (`POST /agent/v1/collections/actions/preview|execute`), autonomy kill-switch | P3 | PRODUCT_ROADMAP.md P3.1, P3.5; VISION §3.5/§3.8 |
| SDKs (OpenAPI-derived TS + Go), developer portal, embedded widgets, usage metering | P4 | PRODUCT_ROADMAP.md P4.1–P4.5 |
| **Live cross-border corridors** (two corridors end-to-end; multi-currency reporting) + localization + data residency | P5 | PRODUCT_ROADMAP.md P5.1–P5.4 |
| CI unblocked (GitHub Actions billing lock; local gates are the documented merge gate) | P0 | ENGINEERING_STATUS.md BLOCKED row |

---

## (b) MARKET-DRIVEN gaps — what competitors and buyers expect that Fuatilia lacks

Derived from the competitor matrix (market-analysis.md §3), persona pricing tolerances (§4), and the
pending-seams list above. Every row is a *product* gap the market will surface in the first 10 customer
conversations, not an internal engineering wish.

| # | Gap | Why the market demands it (evidence/assumption) | Reach | Impact | Conf | Effort | RICE |
|---|---|---|---|---|---|---|---|
| 1 | **SMS runtime provider adapter** (Africa's Talking / Twilio-compatible behind `communications/provider.ts`) | SMS is the universal Kenyan collections channel [K]; today only a simulated provider exists (ENGINEERING_STATUS.md). Every persona's baseline. | 10 | 3 | 100% | 3 | **10.0** |
| 2 | **M-Pesa STK-push as an execution action** ("collect now" from a case; bound by policy engine) | STK is the rail-native way Kenyans pay [W/K]; competitors' links under-convert vs push. Converts NBA output into rail-native money movement. | 8 | 3 | 100% | 3 | **8.0** |
| 3 | **WhatsApp Business API conversational collections** (templates + inbound thread + consent ledger) | WhatsApp is the dominant B2B/B2C conversation surface [K]; vendors claim ~50% late-payment reduction from WhatsApp reminders [W, vendor claim]. Conversational (two-way) is the differentiator vs broadcast. | 9 | 3 | 80% | 5 | **4.3** |
| 4 | **Self-service debtor portal** (balance, invoices, statements, pay-now via link/plan request) | Global AR suites all expose a payer portal [W]; self-service deflects collector time and raises promise-keeping. Reuses webhooks/OpenAPI contract. | 8 | 2 | 80% | 5 | **2.6** |
| 5 | **Accounting intake: CSV + QuickBooks/Zoho Books/Xero sync** (invoices in, payments back) | Buyers won't re-key invoices [K]; global AR tools live or die by ERP sync [W]. Fastest viable path: CSV import + one cloud-accounting adapter. | 7 | 2 | 80% | 5 | **2.2** |
| 6 | **PesaLink / bank-statement reconciliation adapter** | Distributors and schools collect across M-Pesa *and* bank rails [K]; reconciliation is the wedge capability, and bank rails are half of it. | 5 | 2 | 80% | 4 | **2.0** |
| 7 | **Collections analytics on ClickHouse** (DSO, collector effectiveness, cohort recovery curves) | Mid-market buyers expect dashboards [W]; ADR-0002 already defines ClickHouse as the rebuildable analytics store. | 6 | 2 | 80% | 5 | **1.9** |
| 8 | **Credit-behavior scoring data product** (consented payable-behavior scores; CRB/alternative-data export) | Alternative-data scoring on mobile-money patterns is an active Kenyan market [W]; the behavior/memory lanes are the raw material. New revenue line (VISION §7). | 4 | 3 | 50% | 6 | **1.0** |
| 9 | **Voice agent for collections calls (Swahili/English)** — dialer + ASR/TTS with strict transcript-to-audit chain | Voice is a top collections channel in Kenya [K]; global agentic-AR (HighRadius-class) has normalized AI agents [W]. Highest novelty, highest risk. | 5 | 3 | 50% | 8 | **0.9** |
| 10 | **Production cross-border corridor** (first corridor live on the crossborder lane) | Cross-border trade SMEs exist in-persona [K]; domain is complete (F26) but corridors/rails/regulatory footprint are P5. | 3 | 3 | 50% | 8 | **0.6** |
| 11 | **Embedded collections widget** ("Collections powered by Fuatilia" in partner SaaS) | P4 thesis (VISION §6–7); distribution without a sales channel. Sequenced after API/SDK maturity. | 4 | 2 | 50% | 8 | **0.5** |
| 12 | **Offline/field-collector mobile flow** (queue-and-sync actions, low-bandwidth first) | Field collection is real in distribution/construction [K]; SPEC deliberately deferred it (BACKLOG wave-5 note). | 4 | 1 | 50% | 8 | **0.25** |

**Scoring assumptions (all relative, 0–10 index):**
- **Reach** = share of the SAM tier (market-analysis.md §2) that gains material value in one quarter if
  shipped (10 ≈ near-universal need; 1 ≈ niche).
- **Impact** = 3 transformer / 2 meaningful / 1 minor on win-rate or expansion revenue.
- **Confidence** = 100% evidence-backed by shipped seams + market sources; 80% strong inference;
  50% hypothesis needing discovery interviews.
- **Effort** = person-weeks for one senior engineer on the existing architecture (domain-complete lanes
  make 3–5 plausible; 8+ signals new infrastructure).
- Rows 1, 2, 6, 7 are *runtime completions of shipped domains* — low effort because the domain work is
  already merged and tested (this is the compounding return of the ledger-first architecture).

**Structural gaps worth naming (not row items):** (1) no hosted demo environment — P0/P1 blocker for
every buyer conversation; (2) no billing/metering substrate — required for the per-execution pricing the
SOM assumes; (3) no discovery-interview corpus — the 50%-confidence rows above are the research agenda.

---

## (c) Next 10 GitHub issues — the wave-12 pipeline (ordered by RICE)

1. **feat(comms): SMS runtime provider adapter — Africa's Talking/Twilio-compatible, consent-checked**
   Ship a production provider behind the existing `provider.ts` seam: outbound delivery, status callbacks into the comms attempt ladder, `DUNNING_CONSENT_REQUIRED` preserved, delivery events into the audit chain.
2. **feat(payments): M-Pesa STK-push as a policy-gated collections execution action**
   Add "collect now via STK push" to the action vocabulary: NBA-recommendable, policy-engine-evaluated, Daraja-wire-verified at the untrusted boundary, reconciled through the existing intake/match core.
3. **feat(comms): WhatsApp Business API conversational collections**
   Template outbound + inbound thread capture on the conversation lane, WhatsApp opt-in honored from the consent registry, message states reusing the retry→dead-letter ladder.
4. **feat(web): self-service debtor portal**
   Tokenized read-only payer view (balances, invoices, statements) over the OpenAPI contract with pay-now (payment link) and plan-request actions; every view event lands in the audit trail.
5. **feat(intake): accounting sync — CSV invoice import + QuickBooks/Zoho Books payment sync**
   Bulk CSV invoice intake with validation refusals as values, plus a read-only pull adapter mapping external invoices/payments into the receivables/payments lanes; no fund-truth bypass.
6. **feat(payments): PesaLink/bank-statement reconciliation adapter**
   Normalize bank statement feeds into the existing reconciliation match core with confidence scoring hooks; idempotent intake under R9.
7. **feat(analytics): ClickHouse read-model + collections analytics dashboard**
   Event-stream consumer building DSO, aging migration, collector-effectiveness, and cohort-recovery projections; strictly REAL-labeled reporting per the platform's labeling discipline.
8. **feat(intelligence): consented credit-behavior score data product**
   Exportable payable-behavior score (cadence/reliability/exposure features from the memory lane) with explicit consent artifact, DPA-2019 DSAR coverage, and versioned scoring methodology.
9. **feat(comms): voice-agent pilot for collections calls (Swahili/English)**
   Dialer + ASR/TTS behind a provider port; promise/outcome extraction into the promises lane; full transcript redaction via the audit redaction pipeline; human-approval gate on any automated callback commitment.
10. **feat(crossborder): first production corridor end-to-end**
   Bind the crossborder lane to one real rail partner: live quotes with expiry, idempotent settlement intents, fees metered for billing, corridor SLOs instrumented.

*(Prerequisites tracked elsewhere: #72 Go /v1 API kernel and #73 PG persistence adapters must land first — every issue above assumes durable stores and the Go API kernel; issues 1–3 also need the P1 comms-worker surface from PRODUCT_ROADMAP.md P1.)*

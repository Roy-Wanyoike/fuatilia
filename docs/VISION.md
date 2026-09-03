# VISION — Fuatilia as Receivables Intelligence Infrastructure

> Design horizon: **10–15 years, not one release cycle.** Fuatilia is not another invoicing
> SaaS. It is the financial intelligence and execution layer that future AI agents, payment
> rails, banks, ERPs, and businesses can plug into.
>
> **Don't build features for today's SME. Build the layer everything else plugs into.**

Status: direction-setting document. It frames *where* the platform goes; the buildable,
PR-sized units derived from it live in [`docs/BACKLOG.md`](BACKLOG.md) (waves 4–5). The
authoritative domain requirements remain [`docs/SPEC.md`](SPEC.md) and docs 01–08; where the
vision is ahead of the SPEC, the BACKLOG entry says so explicitly.

---

## 1. The platform thesis

```text
                         FUATILIA
              Receivables Intelligence Layer
                           │
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
   FINANCIAL TRUTH    INTELLIGENCE        EXECUTION
        │                  │                  │
     Ledger             AI Models          Workflows
     Payments           Risk Engine        Collections
     Reconciliation     Predictions        Communications
     Receivables        Forecasting         Payments
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                    BUSINESS MEMORY
                           ↓
                  AI AGENT INTERFACE
                           │
       ┌───────────────────┼───────────────────┐
       ↓                   ↓                   ↓
    Human               AI Agent          External System
    Operator                               ERP / Bank / API
```

Three layers, one nervous system:

- **Financial Truth** — the moat. Ledger, payments, reconciliation, receivables. Everything is
  **immutable → auditable → event-driven**. *Ledger-first fund truth* is not compromised for AI.
- **Intelligence** — reads events, never owns fund truth (Design Principle 2). Risk, prediction,
  forecasting, prioritization.
- **Execution** — workflows, collections, communications, payments. Governed by the policy
  engine; every action lands back in the event stream.

Between them, **Business Memory** (event-derived customer financial memory) and an
**Agent Interface** (capability APIs for humans, software, and AI agents).

## 2. The biggest differentiator: an agent-ready financial system

Today's software assumes `Human → UI → Button → Action`. Fuatilia supports:

```text
Human / AI Copilot
        ↓
Policy / Permission Engine
        ↓
Fuatilia (reasons over financial state)
        ↓
Workflow
        ↓
Payment / Collection / Reconciliation
```

The AI never becomes the source of truth. **Fuatilia becomes the trusted execution layer
beneath AI.** This is codified as Design Principle 5 in the README:

> **5. Agent-ready by design** — Fuatilia exposes financial capabilities through governed APIs
> and events so humans, software integrations, and AI agents can safely reason over and act on
> receivables without bypassing financial controls.

## 3. What we build toward

### 3.1 Financial Truth Engine — the moat (shipped, waves 1–3)

Invoices, receivables, payments, allocations, refunds, credit notes, ledger, reconciliation —
all append-only, all event-sourced, corrections are reversing entries. Nothing in this
document overrides it.

### 3.2 The receivables graph

Beyond tables: a connected financial graph per customer —

```text
Customer
   ├── Invoice → Receivable → Collection Case
   ├── Payment → Allocation
   ├── Promise
   ├── Payment Plan
   ├── Dispute
   └── Communication
```

Over time this becomes a **business relationship graph** — extremely valuable input to
intelligence systems. The domain lanes already model these edges opaquely; projections
(F14) and memory (F19/F23) make the graph queryable.

### 3.3 Customer financial memory

Not "customer owes KES 250,000" but:

```text
ABC Hardware
Usually pays:        8–12 days after invoice
Preferred channel:   WhatsApp
Typical payment:     KES 80K–150K
Promise reliability: 82%
Recent behavior:     Deteriorating
Current exposure:    KES 620K
Predicted payment:   KES 400K within 14 days
Risk:                Elevated
```

A continuously evolving **financial memory** derived from events (F19 profiles, F23
explainable memory). Every claim must be traceable to evidence.

### 3.4 Next-Best-Action engine — a defining capability

Not "should we send an SMS?" but **"what is the most effective action we can take right now to
maximize recovery while respecting customer preferences and business policy?"** The engine
weighs amount owed, age, payment history, behavior, promises, communication history, disputes,
risk, channel preference, historical collection outcomes, time, cost, and business policies —
then picks: call / WhatsApp / SMS / payment plan / payment link / human review / escalation /
*do nothing*. Shipped as F22 (wave 5); F13 (wave 4) delivers its scoring precursor.

### 3.5 Autonomous collections — controlled, not free

```text
AI COLLECTION AGENT → understand state → determine intent → recommend action
        ↓
   POLICY ENGINE ──→ allowed → workflow → customer
        └─────────→ approval required → human → workflow → customer
```

The agent autonomously handles **low-risk repetitive work**; higher-risk actions require
approval. Investor framing: **human-controlled autonomy for financial operations.**

### 3.6 Reconciliation intelligence — the Kenya moat

Not reference-lookup but reasoning: candidate invoices → customer identity → historical
behavior → amount similarity → timing → reference patterns → **confidence score** →
automatic match or human review. Crucially, **every human correction becomes
training/evaluation data** — the system gets better at African payment reconciliation over
time. Built on the wave-1 reconciliation core + F15 Daraja conformance fixtures.

### 3.7 Financial AI memory — explainable, not a vector dump

```text
Financial Events → Normalized Facts → Customer Financial Memory
                 → Behavioral Features → Predictions → Recommendations
```

The system must answer **"why did Fuatilia prioritize this customer?"** with actual evidence.
Explainability beats an opaque score in finance.

### 3.8 The Fuatilia Agent API — expose capabilities, not CRUD

```text
GET  /agent/v1/customers/{id}/financial-state
GET  /agent/v1/receivables/priorities
GET  /agent/v1/collections/recommendations
POST /agent/v1/collections/actions/preview
POST /agent/v1/collections/actions/execute
GET  /agent/v1/payments/status
GET  /agent/v1/reconciliation/exceptions
```

An agent should ask *"which customers should I follow up with?"* — never *"give me rows from
the invoices table."* The domain capability layer (queries, projections, action preview/
execute with policy gating) lands as **F21**; the HTTP transport stays deliberately deferred
(SPEC §34/35) until the domain is complete.

### 3.9 The policy engine — AI never decides what it may do

```text
AI → Recommendation → Policy Engine → Permission/Approval → Execution
```

Deterministic policies, e.g.:

```text
IF amount < 50,000 AND risk = low AND customer opted into WhatsApp
THEN AI may send reminder automatically.

IF writeoff > 100,000 THEN human approval required.
```

This is the safety layer between AI and financial execution — **F20** (wave 5). It
generalizes the consent gates (K2) and dunning blocks already shipped in waves 2–3.

### 3.10 The event fabric — the nervous system

Every meaningful action emits an event (`invoice.issued`, `payment.reconciled`,
`promise.broken`, `collection.action.executed`, `customer.behavior.changed`,
`risk.assessment.created`, `recommendation.created`, …). Analytics, AI, forecasting,
notifications, workflows, audit, and integrations all consume the same typed stream. The
wave-2 typed catalog + outbox is this fabric's foundation; it grows with every lane.

## 4. The deterministic / AI divide (non-negotiable)

| Deterministic software owns | AI owns |
|---|---|
| Money, ledger, allocations | Prediction, classification |
| Permissions, authz, policy evaluation | Prioritization, anomaly detection |
| Payments, reconciliation **state** | Natural-language interfaces |
| Compliance (DPA 2019, eTIMS, consent) | Recommendations, forecasting |
| Workflow guarantees | Unstructured communication |

This division is what makes Fuatilia credible to serious investors and regulators.

## 5. Technology direction — staged, not showy

Target shape (stack-mapped): experience layer → API → domains + policy engine + agent API →
PostgreSQL financial truth → domain events → stream (NATS JetStream-class) → workflows →
AI platform (Python, model gateway: LLMs / ML / rules) + analytics (ClickHouse-class).
Supporting infra: Redis, S3, OpenTelemetry, Prometheus/Grafana, Terraform, Kubernetes/ArgoCD,
GitHub Actions.

**But complexity is earned, not deployed on day one:** the application stays a **modular
monolith** (pure TypeScript domain core — exactly this repository) until scale justifies
otherwise. Don't run Kubernetes to look sophisticated. Fuatilia's language decision is
**TypeScript** (see README / SPEC preface); the vision's runtime examples (Go/Python) describe
the long-term shape, not the current stack.

## 6. Position in the product ecosystem

Fuatilia is the **financial/receivables intelligence layer**; the other products are
distribution channels or adjacent systems:

```text
   SharkPay = MOVE money          MjengoOS = construction projects → invoices
        │                                │
        └────────────┬───────────────────┘
                     ↓
                 FUATILIA = UNDERSTAND and COLLECT money
        (AR, reconciliation, collections, forecasting, risk)
                     ↑
     every future SaaS sends customer/invoice/payment events
     and gets back status, risk, recommendations, forecasts —
     "Collections powered by Fuatilia"
```

- **SharkPay** moves money; Fuatilia knows *what the payment means* (which invoice, which
  customer, what remains, what happens next).
- **MjengoOS** issues milestone invoices; Fuatilia takes over receivable → payment →
  reconciliation → collections → forecast. No collections rebuild inside every product.
- Integration is deliberate, not gratuitous — Fuatilia never competes with payment rails.

## 7. Monetization layers (built on one infrastructure)

1. **SaaS subscriptions** (Starter → Growth → Business → Enterprise) — metered on active
   customers, receivables volume, users, automation, integrations; never cripple the cheapest plan.
2. **Payment processing margin** — embedded payments via rails (e.g. Daraja/M-Pesa ecosystem),
   subject to provider/regulatory arrangements.
3. **Collections automation tiers** — manual → automated reminders → AI prioritization →
   autonomous workflows (per case/message/execution/recovered amount).
4. **AI usage** — copilot, reconciliation, forecasting, campaigns: included credits + usage-based.
5. **Fuatilia API** — the biggest long-term opportunity: receivables intelligence as
   infrastructure, metered on calls/entities/transactions/executions.
6. **Embedded Fuatilia** — SDK/API/webhooks/UI components/agent API for platforms
   (B2B2B): *"AI collections powered by Fuatilia."*
7. **Reconciliation API** — standalone matching-as-a-product (confidence-scored, exception queue).
8. **Cash-flow intelligence** — forecasts, expected collections, at-risk AR, customer risk;
   useful even with no active collection.
9. **Enterprise** — SSO, advanced RBAC, audit, custom integrations, SLA, data residency,
   custom AI policies.
10. **Financing referrals** — *last, not first*: with the data/intelligence layer mature,
    appropriately licensed partners could offer working-capital products against strong
    receivables profiles; Fuatilia earns referral/origination fees subject to Kenyan
    regulation. **Do not build lending first.**

## 8. What Fuatilia is NOT

Not invoice + payroll + inventory + CRM + HR + accounting + POS + loans + marketplace +
payments in one app — that is how products lose their identity. Fuatilia owns the space
**between "money is owed" and "money is successfully collected and understood."**
Everything else integrates with it.

## 9. The narrative

> **Fuatilia is an AI-native financial operations platform that gives African businesses a
> trusted system for understanding, collecting, reconciling, and predicting receivables** —
> connecting invoices, payment rails, reconciliation, collections and AI into one
> continuously learning financial system.

The differentiation is not "we also have payment links." It is:

**Fuatilia understands why money is owed, predicts when it will arrive, determines the best
action to recover it, safely executes that action, reconciles the result, and learns from
what happened.**

## 10. How this maps to the backlog

| Vision pillar | Backlog items |
|---|---|
| Financial truth engine | F1–F12 (waves 1–3, shipped) |
| Reconciliation intelligence | F3 (core) + F15 (conformance fixtures) |
| Customer financial memory | F19 (profiles + anomalies) → F23 (explainable memory) |
| Collections intelligence | F13 (priority scoring + feedback) |
| Reporting / graph projections | F14 (segment strategies + projections) |
| Policy engine | F20 (wave 5) |
| Agent API capability layer | F21 (wave 5; HTTP transport deferred) |
| Next-best-action engine | F22 (wave 5, consumes F13/F19/F23 features + F20 policy) |

Each wave-5 lane stays domain-pure (data in → data out, opaque cross-lane ids, stable error
codes) per the repo's shipping rules, so the future HTTP/agent transport can be added without
reworking the core.

> **Implementation note:** this is the original master build-requirements document for the product
> (the "classic code" brief). Fuatilia's language decision is **TypeScript** (see README) — stack
> sections that mandate other runtimes are superseded; the product features, domain
> requirements, workflows, testing standards and API shape below remain authoritative inputs.
> The accepted design that implements it lives in docs/01–08.

# MASTER BUILD PROMPT — AFRICAN SME COLLECTIONS OS

## Role

Act as a principal software architect, staff Go engineer, distributed-systems engineer, fintech infrastructure engineer, AI/ML architect, security engineer, DevOps engineer, and senior product engineer.

You are building a production-grade **African SME Collections OS**.

Do not build a generic invoicing SaaS.

Do not build a simple payment gateway.

Do not build a CRM with AI added on top.

Build an **AI-native receivables infrastructure and collections operating system for African SMEs**.

The system must be designed to eventually operate at large scale across multiple African countries and payment ecosystems.

---

# 1. PRODUCT VISION

The platform solves one fundamental problem:

> **Help African SMEs understand who owes them money, predict who will pay, determine what action should happen next, execute collection workflows automatically, reconcile incoming payments, and continuously learn from payment behavior.**

The core loop is:

```text
Customer
    ↓
Invoice / Receivable
    ↓
Due Date
    ↓
Collections Intelligence
    ↓
Next Best Action
    ↓
WhatsApp / SMS / Email / USSD / Human
    ↓
Payment Link / Mobile Money / Bank / Card
    ↓
Payment
    ↓
Webhook
    ↓
Transaction
    ↓
Reconciliation
    ↓
Ledger
    ↓
Receipt
    ↓
Customer Behavior Update
    ↓
Risk Update
    ↓
Forecast Update
    ↓
Better Future Collection Decision
```

The product must create a continuous learning loop.

---

# 2. STRATEGIC POSITIONING

The platform should ultimately become:

> **The financial operations OS for African SMEs, starting with receivables and collections.**

The first wedge is collections.

Future expansion can include:

* Payment infrastructure
* Reconciliation
* Cash-flow intelligence
* Financial health
* Embedded finance
* SME credit intelligence
* Cross-border payments
* Financing integrations
* Broader financial operations

Do not implement every future feature immediately.

Build the architecture so these capabilities can be added without rewriting the core.

---

# 3. PRIMARY DIFFERENTIATORS

These are not optional ideas. They should influence the architecture.

## A. Collections Intelligence Graph

Build a continuously evolving relationship graph connecting:

```text
Organization
Customer
Contact
Invoice
Receivable
Payment
Payment Method
Communication
Collection Action
Promise
Payment Plan
Dispute
Risk
Behavior
Forecast
```

The system should understand relationships between these entities.

Example:

```text
Customer
   ↓
Invoice
   ↓
Reminder
   ↓
WhatsApp response
   ↓
Promise to pay
   ↓
Payment
   ↓
Reconciliation
   ↓
Promise fulfilled
   ↓
Customer behavior updated
```

This graph should power future intelligence.

---

# 4. CUSTOMER PAYMENT BEHAVIOR ENGINE

For every customer, continuously calculate behavioral characteristics such as:

* Average payment delay
* Median payment delay
* On-time payment percentage
* Late-payment frequency
* Promise-to-pay fulfillment rate
* Partial-payment frequency
* Average payment amount
* Payment frequency
* Preferred payment rail
* Preferred communication channel
* Response rate
* Response time
* Dispute frequency
* Invoice size distribution
* Seasonal behavior
* Outstanding exposure
* Collection success rate
* Historical recovery rate

Track behavioral changes over time.

Example:

```text
Historical average payment delay:
6 days

Current payment delay:
24 days

Behavior change:
SIGNIFICANT
```

Create a behavioral anomaly event.

---

# 5. CUSTOMER FINANCIAL DIGITAL TWIN

Every customer should have a current financial state.

Example:

```text
ABC Hardware

Outstanding:
KES 840,000

Overdue:
KES 420,000

Expected:
KES 600,000

Average payment delay:
11 days

Promise fulfillment:
83%

Response rate:
72%

Preferred channel:
WhatsApp

Preferred payment rail:
Mobile Money

Risk:
Medium

Collection stage:
Escalation

Next Best Action:
WhatsApp + payment plan
```

This state should update from domain events.

Do not calculate everything only when a page is loaded.

Build reusable domain services and projections.

---

# 6. NEXT BEST ACTION ENGINE

Create a dedicated decision engine.

For every receivable/customer combination, determine:

* Whether action is needed
* When action should happen
* Which communication channel
* What message strategy
* What payment option
* Whether a payment plan should be offered
* Whether a human should intervene
* Whether escalation is appropriate

Example:

```text
Customer:
ABC Hardware

Outstanding:
KES 420,000

Days overdue:
38

Recommended action:
WhatsApp

Recommended strategy:
Request partial payment

Alternative:
3-installment payment plan

Escalate:
48 hours after no response

Confidence:
87%

Reasons:
- Customer historically responds to WhatsApp
- Customer normally pays within 10 days
- Current delay is abnormal
- Customer previously used payment plans successfully
```

The recommendation must be explainable.

---

# 7. COLLECTIONS AUTOPILOT

Allow organizations to configure automated collection strategies.

Example:

```text
Invoice becomes overdue
        ↓
Evaluate customer
        ↓
Calculate risk
        ↓
Calculate next best action
        ↓
Select communication channel
        ↓
Generate message
        ↓
Policy validation
        ↓
Send
        ↓
Wait
        ↓
Payment?
   ┌────┴────┐
  YES       NO
   ↓         ↓
Reconcile   Escalate
   ↓         ↓
Receipt     Human review
```

Use durable workflows.

The workflow must survive:

* Application crashes
* Worker crashes
* Deployments
* Network failures
* Provider downtime
* Temporary database issues

---

# 8. AI AGENT ARCHITECTURE

Create specialized AI agents.

## Receivables Agent

Finds receivables requiring attention.

## Customer Intelligence Agent

Analyzes customer behavior.

## Risk Agent

Evaluates collection risk.

## Communication Agent

Generates contextual customer communication.

## Reconciliation Agent

Assists in identifying payment/invoice matches.

## Forecast Agent

Predicts collections and cash flow.

## Collections Orchestrator Agent

Coordinates recommendations from other agents.

Agents must never directly manipulate financial records or move money.

Use:

```text
AI
 ↓
Structured recommendation
 ↓
Policy Engine
 ↓
Validation
 ↓
Human approval if required
 ↓
Deterministic backend service
 ↓
Financial operation
```

---

# 9. AI COPILOT

Build a conversational financial operations assistant.

Users should be able to ask:

```text
Who owes us the most?

Who should we contact today?

Which customers have changed their payment behavior?

How much should we collect this week?

Which promises are likely to be broken?

Why did collections drop this month?

What happens if ABC Hardware doesn't pay?

Show me all invoices older than 30 days.

Create a collection campaign for invoices over 14 days overdue.
```

For actions, produce a structured plan before execution.

Example:

```text
Found:
43 invoices

Outstanding:
KES 2.8M

Proposed:
31 WhatsApp messages
12 emails
6 human escalations

Predicted recovery:
KES 1.9M
```

Require approval unless organization automation policies permit automatic execution.

---

# 10. PAYMENT PROMISE ENGINE

Create first-class Promise-to-Pay entities.

Fields:

* Customer
* Invoice
* Amount
* Currency
* Promised date
* Created date
* Source
* Communication
* Status
* Fulfillment status
* Actual payment date
* Actual amount
* Broken reason
* Confidence

States:

```text
Created
Pending
Partially Fulfilled
Fulfilled
Broken
Cancelled
Expired
```

A broken promise must trigger the appropriate collection workflow.

---

# 11. PAYMENT PLAN ENGINE

Support structured installment plans.

Example:

```text
Outstanding:
KES 600,000

Installment 1:
KES 100,000 — Sept 5

Installment 2:
KES 100,000 — Sept 12

Installment 3:
KES 150,000 — Sept 19

Installment 4:
KES 250,000 — Sept 26
```

Automatically:

* Track installments
* Generate payment requests
* Send reminders
* Detect missed installments
* Reconcile payments
* Update balances
* Escalate missed payments

---

# 12. AFRICAN MULTI-RAIL PAYMENT ORCHESTRATION

Never hard-code a single payment provider into the core.

Create provider interfaces.

Examples:

```text
PaymentProvider
PaymentVerificationProvider
SettlementProvider
NotificationProvider
BankProvider
```

Build adapters/connectors.

Support architecture for:

* Mobile money
* Bank transfer
* Cards
* QR
* Payment links
* USSD
* Future African payment providers

Adding another provider must not require rewriting collections logic.

---

# 13. PAYMENT LIFECYCLE

Implement explicit payment states:

```text
Created
Initiated
Pending
Authorized
Completed
Failed
Expired
Cancelled
Refunded
Partially Refunded
```

Payments must support:

* Idempotency
* Provider references
* Internal references
* Webhooks
* Retry
* Verification
* Settlement
* Reconciliation
* Audit

Never trust a client-side payment-success response as final confirmation.

---

# 14. WEBHOOK INFRASTRUCTURE

Create a robust webhook subsystem.

Requirements:

* Signature verification
* Idempotency
* Replay protection
* Raw event storage
* Event versioning
* Provider mapping
* Retry handling
* Dead-letter handling
* Observability

Example:

```text
Provider webhook
      ↓
Authenticate
      ↓
Persist raw event
      ↓
Idempotency check
      ↓
Normalize
      ↓
Publish domain event
      ↓
Process
```

Never process provider webhooks only in-memory.

---

# 15. INTELLIGENT RECONCILIATION

Build a reconciliation engine.

Input:

```text
Incoming transaction
```

Possible matches:

```text
INV-9281    96%
INV-9274     3%
Unknown      1%
```

Match using signals such as:

* Amount
* Reference
* Customer identity
* Phone number
* Account
* Invoice number
* Payment provider
* Historical behavior
* Payment timing

Support:

```text
Automatic Match
Suggested Match
Manual Review
Rejected
```

Allow configurable confidence thresholds.

Human corrections should become learning signals.

---

# 16. RECONCILIATION EXCEPTION CENTER

Create a dedicated workspace for:

* Unknown payer
* Unknown invoice
* Amount mismatch
* Duplicate payment
* Possible duplicate transaction
* Missing reference
* Multiple possible invoices
* Partial payment
* Overpayment
* Underpayment
* Reversed payment
* Settlement mismatch

Every resolution must be audited.

---

# 17. FINANCIAL LEDGER

Build an auditable ledger subsystem.

Financial history must not be destroyed by overwriting records.

Use appropriate ledger/transactional design.

Every monetary movement should have:

* Amount
* Currency
* Direction
* Account/context
* Reference
* Source
* Idempotency key
* Timestamp
* Actor/system
* Status

Use integer minor units or fixed-precision decimal types.

Never use floating-point arithmetic for money.

Corrections should use reversal/adjustment records where appropriate.

---

# 18. COLLECTIONS WORKFLOW ENGINE

Support configurable workflows.

Example:

```text
3 days before due date
→ Friendly reminder

Due date
→ Payment request

3 days overdue
→ WhatsApp

7 days overdue
→ SMS

14 days overdue
→ Collector task

30 days overdue
→ Manager escalation

45 days overdue
→ Payment plan

60+ days
→ Recovery workflow
```

Make this configurable.

Do not hard-code these rules.

---

# 19. COLLECTION STRATEGY ENGINE

Organizations can create strategies based on:

* Customer segment
* Invoice size
* Days overdue
* Risk
* Customer value
* Industry
* Payment behavior
* Dispute state

Example:

```text
High-value customer
+
Low risk
+
First overdue event

→ Friendly communication
```

versus:

```text
High risk
+
Repeated broken promises
+
60+ days overdue

→ Human escalation
```

---

# 20. COLLECTION STRATEGY SIMULATOR

Before activating a strategy:

```text
Target:
Invoices >14 days overdue

Customers:
127

Outstanding:
KES 8.4M

Strategy:
WhatsApp → SMS → Human

Predicted recovery:
KES 5.9M
```

Clearly label predictions as predictions.

Allow:

```text
[Simulate]
[Save Strategy]
[Activate]
```

---

# 21. COLLECTION EXPERIMENTATION

Support controlled experimentation.

Test:

* Message
* Timing
* Channel
* Reminder frequency
* Payment-plan offer
* Escalation timing

Measure:

* Response rate
* Payment conversion
* Recovery amount
* Time to payment
* Promise fulfillment
* Disputes

---

# 22. CASH-FLOW FORECASTING

Build:

* Expected collections
* Predicted collections
* At-risk collections
* Aging-based forecasts
* Customer-level forecasts
* Weekly forecasts
* Monthly forecasts

Example:

```text
Expected:
KES 10M

Likely:
KES 7.2M

At Risk:
KES 2.8M
```

Clearly distinguish actual values from predictions.

---

# 23. WHAT-IF SIMULATOR

Allow:

```text
What happens if our top customer pays 30 days late?

What happens if collection rate drops by 10%?

What happens if all invoices over 30 days are delayed another 15 days?
```

Return projected impact on cash flow.

---

# 24. BEHAVIORAL ANOMALY DETECTION

Detect deviations such as:

* Sudden payment delays
* Sudden payment-size changes
* New payment methods
* Increased disputes
* Reduced communication response
* Unusual transaction patterns

Create explainable alerts.

---

# 25. CUSTOMER RISK ENGINE

Create configurable risk categories:

```text
Low
Medium
High
Critical
Disputed
Unknown
```

Risk should consider:

* Days overdue
* Historical payment behavior
* Outstanding exposure
* Promise behavior
* Dispute history
* Payment consistency
* Customer concentration
* Behavioral changes

Do not present predictions as guaranteed outcomes.

---

# 26. UNIFIED COLLECTIONS INBOX

Create one interface for:

* WhatsApp
* SMS
* Email
* In-app messaging
* Internal collector notes

Each communication must connect to:

```text
Customer
Invoice
Receivable
Collection Case
Promise
Payment
```

---

# 27. CUSTOMER SELF-SERVICE PORTAL

Customers can:

* View invoices
* Pay invoices
* View statements
* View payment history
* Request payment plans
* Make partial payments
* Submit disputes
* Download receipts
* Update permitted information

Create secure customer authentication.

---

# 28. PAYMENT LINKS

Create secure payment links.

Example:

```text
ABC Hardware

Invoice:
INV-9281

Amount:
KES 85,000

[Pay Now]
```

Support:

* Expiration
* Single-use configuration
* Partial payment
* Full payment
* Multiple payment methods
* Secure tokenization
* Payment status

---

# 29. DISPUTE MANAGEMENT

Create:

```text
Dispute
Dispute Category
Evidence
Messages
Assigned User
Status
Resolution
```

States:

```text
Opened
Investigating
Awaiting Customer
Awaiting Business
Resolved
Rejected
Cancelled
```

A disputed invoice should not blindly continue aggressive collection automation.

---

# 30. FIELD COLLECTIONS

Build architecture for mobile/field agents.

Support:

* Assigned customers
* Assigned receivables
* Collection tasks
* Offline mode
* Customer lookup
* Collection recording
* Receipts
* Notes
* Synchronization
* Conflict resolution

Design for low-connectivity environments.

---

# 31. USSD / LOW-TECH SUPPORT

Design APIs for USSD workflows.

Potential flow:

```text
Check balance
Pay invoice
View invoice
Request payment plan
Get statement
```

Do not assume every customer has a smartphone.

---

# 32. AFRICAN LOCALIZATION

The platform must be designed for multiple African countries.

Architect for:

* Multiple currencies
* Country configuration
* Local payment providers
* Mobile money
* Banks
* USSD
* WhatsApp
* SMS
* Local tax requirements
* Local invoice formats
* Multiple time zones
* Local business identifiers

Do not hard-code Kenya-specific assumptions into core business logic.

Kenya can be the first market.

---

# 33. CROSS-BORDER ARCHITECTURE

Prepare for:

```text
Country A
   ↓
Invoice
   ↓
Currency
   ↓
Payment Rail
   ↓
FX
   ↓
Settlement
   ↓
Reconciliation
```

Do not implement speculative cross-border functionality prematurely, but ensure the domain model supports currency and country boundaries.

---

# 34. AUTHENTICATION

Implement production-grade authentication architecture.

Support:

* Email/password
* OIDC/OAuth2
* Session management
* MFA-ready architecture
* Password reset
* Email verification
* Device/session management
* Account recovery
* Organization membership

Never store plaintext passwords.

---

# 35. AUTHORIZATION

Implement:

* RBAC
* Fine-grained permissions
* Optional ABAC
* Organization isolation
* Resource-level authorization

Example roles:

```text
Owner
Admin
Finance Manager
Accountant
Collector
Customer Support
Auditor
Developer
```

Permissions must be granular.

Example:

```text
invoice.read
invoice.create
invoice.update
invoice.delete

payment.read
payment.create
payment.refund

reconciliation.read
reconciliation.resolve

collection.read
collection.execute

writeoff.create
writeoff.approve
```

---

# 36. MAKER-CHECKER

Sensitive financial operations should support approval workflows.

Examples:

```text
Large refund
→ Manager approval

Write-off
→ Manager approval

Large credit note
→ Approval

Bank/payment destination change
→ Approval

Manual adjustment
→ Approval
```

Approval policies should be configurable by organization.

---

# 37. AUDIT SYSTEM

Audit every important action.

Store:

* Organization
* Actor
* Action
* Entity
* Entity ID
* Timestamp
* Request ID
* Correlation ID
* IP where appropriate
* User-agent/device metadata where appropriate
* Previous state
* New state
* Reason
* Approval information

Audit logs must be append-only from the application's perspective.

AI actions must also be auditable.

---

# 38. API DESIGN

Build APIs using:

* Go
* REST
* OpenAPI
* JSON
* Versioned endpoints

Example:

```text
/v1/customers
/v1/invoices
/v1/receivables
/v1/payments
/v1/payment-links
/v1/payment-plans
/v1/promises
/v1/collections
/v1/reconciliation
/v1/disputes
/v1/notifications
/v1/webhooks
/v1/analytics
/v1/ai
```

Use consistent:

* Pagination
* Filtering
* Sorting
* Error formats
* Validation
* Idempotency
* Request IDs

---

# 39. EVENT-DRIVEN ARCHITECTURE

Use NATS JetStream.

Create strongly typed events.

Examples:

```text
organization.created

customer.created
customer.updated
customer.behavior.changed
customer.risk.changed

invoice.created
invoice.sent
invoice.viewed
invoice.due
invoice.overdue
invoice.paid

payment.created
payment.initiated
payment.pending
payment.completed
payment.failed
payment.refunded

payment.reconciled

promise.created
promise.fulfilled
promise.broken

payment_plan.created
payment_plan.installment_due
payment_plan.installment_paid
payment_plan.installment_missed

collection.started
collection.action.created
collection.action.sent
collection.action.completed
collection.escalated

dispute.created
dispute.resolved

forecast.updated
```

All consumers must be idempotent.

---

# 40. TEMPORAL WORKFLOWS

Use Temporal for long-running processes.

Implement workflows for:

* Automated collections
* Reminder sequences
* Payment plans
* Promise monitoring
* Escalations
* Payment processing
* Provider retries
* Reconciliation
* Dispute workflows
* Collection campaigns
* Customer onboarding

Do not use Temporal for ordinary CRUD.

Use it where workflows involve:

* Time
* Waiting
* Retries
* External providers
* Human interaction
* Long-running state

---

# 41. TECHNOLOGY STACK

## Backend

Mandatory:

* Go
* Go modules
* REST
* OpenAPI
* gRPC/ConnectRPC where appropriate

## Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui
* TanStack Query
* Zustand only where needed

## Data

* PostgreSQL
* Redis
* ClickHouse
* S3-compatible object storage

## Messaging

* NATS
* NATS JetStream

## Durable execution

* Temporal

## AI/ML

* Python
* ML services
* LLM Gateway
* Model routing
* Structured outputs
* Evaluation framework

## Infrastructure

* Docker
* Kubernetes
* Helm
* Terraform
* Argo CD
* GitHub Actions

## Observability

* OpenTelemetry
* Prometheus
* Grafana
* Loki
* Tempo

---

# 42. DATABASE ARCHITECTURE

PostgreSQL is the transactional source of truth.

Use PostgreSQL for:

* Organizations
* Users
* Customers
* Contacts
* Invoices
* Receivables
* Payments
* Payment plans
* Promises
* Disputes
* Permissions
* Configuration
* Financial records

ClickHouse is for analytics.

Use ClickHouse for:

* Event analytics
* Payment behavior
* Collection analytics
* Risk analytics
* Customer trends
* Forecast datasets
* High-volume reporting
* Real-time analytical dashboards

Redis is for:

* Caching
* Rate limiting
* Short-lived state
* Idempotency support
* Performance optimization

Do not make Redis or ClickHouse the financial source of truth.

---

# 43. MONETARY DATA

Never use floating point for money.

Use:

* Integer minor units, or
* Fixed precision decimal

Every amount must have an explicit currency.

Example:

```text
amount:
8500000

currency:
KES
```

or an equivalent fixed-precision representation.

Never assume currency from organization settings.

---

# 44. IDEMPOTENCY

Financial endpoints must support idempotency.

Examples:

```text
POST /payments
POST /payment-links
POST /refunds
POST /reconciliation
```

Support:

```text
Idempotency-Key
```

Duplicate requests must not create duplicate financial effects.

---

# 45. FRONTEND EXPERIENCE

The application should feel like:

**Stripe Dashboard + Linear + modern banking operations console + AI-native workspace**

It should NOT feel like old accounting software.

Primary navigation:

```text
Overview

Customers
Invoices
Receivables

Collections
Payment Plans
Promises

Payments
Payment Links
Reconciliation

Disputes
Communications
Collections Inbox

AI Copilot
Risk Intelligence
Cash Flow
Analytics

Integrations
Developers

Team
Permissions
Audit Log

Settings
```

---

# 46. EXECUTIVE DASHBOARD

Display:

```text
Outstanding Receivables
Overdue
Collected This Month
Collection Rate
Expected Collections
At-Risk Collections
DSO
Broken Promises
Active Collections
```

Then:

## AI Priority Queue

```text
Customer
Amount
Days overdue
Risk
Recommended action
Reason
```

Actions:

```text
Review
Execute
Dismiss
```

---

# 47. CUSTOMER 360

Create a rich customer page.

Sections:

```text
Overview
Financial State
Invoices
Payments
Promises
Payment Plans
Disputes
Communications
Collections
Risk
Behavior
Timeline
```

Include a chronological relationship timeline.

---

# 48. COLLECTIONS WORKSPACE

Create a Kanban/list hybrid:

```text
Upcoming
Due
1–7 Days
8–30 Days
31–60 Days
61–90 Days
90+ Days
Promise Pending
Disputed
Escalated
```

Allow filtering by:

* Amount
* Risk
* Customer
* Collector
* Country
* Currency
* Payment method
* Collection stage

---

# 49. RECONCILIATION UI

Create:

```text
Matched
Suggested
Unmatched
Duplicates
Amount Mismatch
Unknown Payer
Needs Review
```

Show matching evidence.

Example:

```text
Possible Match

Invoice:
INV-9281

Confidence:
96%

Signals:
Reference match
Amount match
Customer match
Payment timing match
```

---

# 50. AI EXPLAINABILITY

Every important AI recommendation should be explainable.

Show:

```text
Recommendation
Confidence
Reasons
Supporting data
Historical patterns
Potential alternatives
```

Do not expose private chain-of-thought.

Provide concise decision factors and evidence.

---

# 51. AI MODEL GOVERNANCE

Build infrastructure for:

* Model registry
* Prompt versioning
* Model versioning
* Evaluation
* Cost tracking
* Token tracking
* Latency tracking
* Failure tracking
* Structured output validation
* Safety filters
* PII redaction
* Fallback models

Never tightly couple business logic to a single LLM provider.

---

# 52. AI GATEWAY

Create a centralized AI Gateway.

Responsibilities:

```text
Model routing
Provider fallback
Structured outputs
Token tracking
Cost tracking
Prompt versioning
Logging
PII handling
Policy enforcement
Evaluation hooks
```

The rest of the backend should call the AI Gateway rather than directly calling individual model providers.

---

# 53. DEVELOPER PLATFORM

Create:

* API keys
* OAuth applications
* Webhooks
* Sandbox
* Developer documentation
* API logs
* Webhook logs
* Usage analytics
* Rate limits

Webhook events should include:

```text
invoice.created
invoice.overdue
payment.completed
payment.failed
payment.reconciled
promise.created
promise.broken
collection.completed
dispute.created
```

Sign outbound webhooks.

Support webhook retries and replay.

---

# 54. INTEGRATION ARCHITECTURE

Use interfaces/adapters.

Example:

```text
internal/integrations/

payment/
    provider.go
    mpesa/
    bank/
    card/

messaging/
    provider.go
    whatsapp/
    sms/
    email/

accounting/
    provider.go
    quickbooks/
    xero/
```

Domain logic must not depend on provider-specific implementation.

---

# 55. GO PROJECT STRUCTURE

Start as a modular monolith.

Do NOT create dozens of microservices prematurely.

Recommended structure:

```text
backend/
├── cmd/
│   ├── api/
│   ├── worker/
│   └── migration/
│
├── internal/
│   ├── identity/
│   ├── organizations/
│   ├── users/
│   ├── customers/
│   ├── invoices/
│   ├── receivables/
│   ├── collections/
│   ├── paymentplans/
│   ├── promises/
│   ├── payments/
│   ├── paymentlinks/
│   ├── reconciliation/
│   ├── disputes/
│   ├── notifications/
│   ├── communications/
│   ├── ledger/
│   ├── risk/
│   ├── forecasting/
│   ├── analytics/
│   ├── audit/
│   ├── integrations/
│   ├── workflows/
│   └── ai/
│
├── pkg/
│
├── api/
│   └── openapi/
│
├── migrations/
│
├── deployments/
│
└── tests/
```

Keep domain boundaries strict.

Extract services only when there is a genuine reason.

---

# 56. FRONTEND STRUCTURE

Use:

```text
frontend/
├── app/
├── components/
├── features/
│   ├── dashboard/
│   ├── customers/
│   ├── invoices/
│   ├── receivables/
│   ├── collections/
│   ├── payments/
│   ├── reconciliation/
│   ├── disputes/
│   ├── communications/
│   ├── analytics/
│   └── ai/
│
├── lib/
├── hooks/
├── stores/
├── types/
└── tests/
```

Keep feature ownership clear.

---

# 57. TESTING

Every feature must include:

* Unit tests
* Integration tests
* API tests
* Database tests
* Event tests
* Workflow tests
* Contract tests
* Permission tests
* Failure tests

Financial features additionally require:

* Idempotency tests
* Duplicate webhook tests
* Concurrent transaction tests
* Reconciliation tests
* Ledger tests
* Provider failure tests
* Retry tests
* Rollback/reversal tests

AI features require:

* Evaluation datasets
* Structured-output validation
* Hallucination tests
* Regression tests
* Prompt/version tests
* Safety tests

---

# 58. FAILURE TESTING

Explicitly test:

```text
Provider timeout
Provider unavailable
Webhook duplicated
Webhook delayed
Webhook reordered
Worker crash
API crash
Database connection failure
NATS redelivery
Temporal worker restart
Redis unavailable
ClickHouse unavailable
Network interruption
Duplicate payment request
Concurrent reconciliation
```

The system must fail safely.

Never silently lose a financial event.

---

# 59. OBSERVABILITY

Use OpenTelemetry.

Every request/event/workflow should support correlation through:

```text
request_id
trace_id
correlation_id
organization_id
```

Monitor:

* API latency
* Error rates
* Payment success rate
* Provider latency
* Webhook processing
* Event lag
* Temporal workflow failures
* Reconciliation latency
* AI latency
* AI cost
* Database performance

---

# 60. SECURITY

Implement:

* Encryption in transit
* Encryption at rest
* Secure secrets management
* Tenant isolation
* RBAC
* Fine-grained authorization
* Rate limiting
* Input validation
* Output validation
* Security headers
* CSRF protection where applicable
* Secure cookies
* API key security
* Webhook signature verification
* Audit logs
* Dependency scanning
* Container scanning

Follow secure-by-default principles.

---

# 61. MULTI-TENANCY

Every organization is a tenant.

All tenant-owned resources must have organization ownership.

Never rely only on frontend filtering.

Authorization must be enforced server-side.

Test for cross-tenant access explicitly.

---

# 62. CI/CD

Every pull request should run:

```text
Formatting
Linting
Unit tests
Integration tests
API tests
Security scanning
Dependency scanning
Build
Container build
Migration validation
```

Deployment:

```text
Pull Request
      ↓
CI
      ↓
Staging
      ↓
Integration tests
      ↓
Smoke tests
      ↓
Approval
      ↓
Production
```

Use GitOps.

---

# 63. INFRASTRUCTURE

Use:

```text
Docker
Kubernetes
Terraform
Helm
Argo CD
GitHub Actions
```

Separate:

```text
development
staging
production
```

Infrastructure must be reproducible.

---

# 64. DATABASE MIGRATIONS

Use a proper migration system.

Requirements:

* Versioned migrations
* Rollback strategy
* Migration validation
* CI migration testing
* Production safety checks

Never make destructive schema changes casually.

---

# 65. API DOCUMENTATION

Maintain OpenAPI continuously.

Every endpoint should document:

* Authentication
* Authorization
* Request schema
* Response schema
* Errors
* Pagination
* Idempotency
* Examples

Generate typed clients where useful.

---

# 66. BUSINESS METRICS

Track:

```text
Outstanding receivables
Overdue amount
Collection rate
Recovery rate
DSO
Average payment delay
Promise fulfillment
Payment conversion
Collection action success
Channel effectiveness
Reconciliation accuracy
Forecast accuracy
Customer concentration
At-risk cash
```

---

# 67. PLATFORM HEALTH METRICS

Track:

```text
Payment success rate
Webhook success rate
Webhook processing latency
Event processing latency
Workflow failure rate
Provider uptime
API uptime
Reconciliation match rate
AI recommendation acceptance
AI recommendation accuracy
AI cost per organization
```

---

# 68. IMPLEMENTATION ORDER

Do NOT attempt to build everything simultaneously.

Build in vertical slices.

## PHASE 1 — FOUNDATION

Implement:

* Repository
* Go backend
* Next.js frontend
* PostgreSQL
* Redis
* NATS JetStream
* Temporal
* ClickHouse
* Authentication
* Organizations
* Users
* RBAC
* Audit
* Observability
* CI/CD
* Docker development environment

---

## PHASE 2 — RECEIVABLES

Implement:

* Customers
* Customer contacts
* Customer 360
* Invoices
* Invoice lifecycle
* Receivables
* Aging
* Statements
* Payment plans
* Promises

---

## PHASE 3 — COLLECTIONS

Implement:

* Collection cases
* Collection actions
* Collection strategies
* Collection workflows
* Reminders
* Escalations
* Collections workspace
* Collections inbox

---

## PHASE 4 — PAYMENTS

Implement:

* Payment abstraction
* Payment lifecycle
* Payment links
* Provider interfaces
* Sandbox provider
* Webhooks
* Idempotency
* Payment verification
* Settlement tracking

Start with mock/sandbox providers before production integrations.

---

## PHASE 5 — RECONCILIATION

Implement:

* Transaction ingestion
* Matching engine
* Confidence scoring
* Automatic matching
* Suggested matching
* Manual reconciliation
* Exception handling
* Reconciliation audit

---

## PHASE 6 — INTELLIGENCE

Implement:

* Customer behavior engine
* Risk engine
* Collection priority
* Next best action
* Behavioral anomaly detection
* Cash-flow forecasting
* What-if simulator
* Collection strategy simulator

---

## PHASE 7 — AI

Implement:

* AI Gateway
* AI Copilot
* Receivables Agent
* Customer Intelligence Agent
* Risk Agent
* Communication Agent
* Reconciliation Agent
* Forecast Agent
* Collections Orchestrator

AI must use structured outputs and deterministic execution boundaries.

---

## PHASE 8 — AFRICAN PAYMENT INFRASTRUCTURE

Implement provider connectors and architecture for:

* Mobile money
* Bank payments
* Cards
* USSD
* WhatsApp
* SMS

Provider-specific logic stays inside adapters.

---

## PHASE 9 — FIELD/OFFLINE

Implement:

* Field collectors
* Offline-first mobile workflows
* Synchronization
* Conflict resolution
* USSD APIs
* Low-bandwidth behavior

---

## PHASE 10 — DEVELOPER PLATFORM

Implement:

* API keys
* OAuth
* Webhooks
* Sandbox
* Developer portal
* API analytics
* Usage limits

---

# 69. IMPORTANT PRODUCT PRINCIPLE

The system should continuously answer:

> **Who should we collect from, why, through which channel, when, for how much, and what should happen next?**

That should be the central product philosophy.

---

# 70. IMPORTANT ENGINEERING PRINCIPLE

Do not build a fake demo.

Every completed feature must work end-to-end:

```text
Database
 ↓
Domain
 ↓
API
 ↓
Event
 ↓
Workflow
 ↓
Frontend
 ↓
Permissions
 ↓
Audit
 ↓
Tests
 ↓
Observability
```

If a feature only exists in the UI, it is not complete.

If an API exists without authorization, it is not complete.

If a financial operation exists without idempotency, it is not complete.

If a workflow exists without failure handling, it is not complete.

---

# 71. GIT AND DEVELOPMENT DISCIPLINE

Work using feature branches.

Never directly push unfinished work to the main branch.

Each pull request should represent a complete vertical feature.

Every PR should:

* Build successfully
* Pass tests
* Have no merge conflicts
* Include migrations where necessary
* Include API changes
* Include frontend changes where required
* Include documentation
* Include tests
* Include observability
* Include audit behavior
* Include permissions

Do not create meaningless PRs that only change a few unrelated files.

---

# 72. FINAL PRODUCT QUALITY

The final platform should feel comparable to a serious financial infrastructure company.

It should be:

* Fast
* Reliable
* Secure
* Observable
* Auditable
* Multi-tenant
* AI-native
* Event-driven
* Workflow-driven
* African-first
* Mobile-money friendly
* WhatsApp-friendly
* Low-bandwidth friendly
* Developer-friendly

Avoid unnecessary complexity.

Use modern technologies where they provide real value.

---

# 73. FINAL PRODUCT LOOP

The finished system should create this loop:

```text
                  CUSTOMER
                     │
                     ↓
                  INVOICE
                     │
                     ↓
                RECEIVABLE
                     │
                     ↓
          COLLECTION INTELLIGENCE
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
       RISK      NEXT ACTION   FORECAST
        │            │            │
        └────────────┼────────────┘
                     ↓
                AI AGENTS
                     │
                     ↓
             COLLECTION ACTION
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
     WhatsApp       SMS         Human
        │            │            │
        └────────────┼────────────┘
                     ↓
                  PAYMENT
                     │
                     ↓
                 WEBHOOK
                     │
                     ↓
               TRANSACTION
                     │
                     ↓
              RECONCILIATION
                     │
                     ↓
                  LEDGER
                     │
                     ↓
                 RECEIPT
                     │
                     ↓
             CUSTOMER BEHAVIOR
                     │
                     ↓
              RISK / FORECAST
                     │
                     └──────────────→ NEXT DECISION
```

This feedback loop is the core of the product.

---

# 74. DEFINITION OF DONE

The platform is not complete merely because users can create invoices.

A production-ready vertical slice must demonstrate:

```text
Customer created
      ↓
Invoice created
      ↓
Invoice delivered
      ↓
Invoice becomes due
      ↓
Collection workflow starts
      ↓
Collection action generated
      ↓
Customer contacted
      ↓
Payment initiated
      ↓
Provider webhook received
      ↓
Payment verified
      ↓
Transaction recorded
      ↓
Payment reconciled
      ↓
Ledger updated
      ↓
Receipt generated
      ↓
Invoice balance updated
      ↓
Customer behavior updated
      ↓
Analytics updated
      ↓
Risk updated
      ↓
Future collection recommendation updated
```

This entire path must work reliably.

---

# 75. NORTH STAR

Do not optimize the product around the number of invoices created.

Optimize around:

> **Cash successfully collected, time-to-payment reduced, reconciliation automated, and SME financial visibility improved.**

The ultimate vision is:

**From receivables software → to collections intelligence → to African SME financial infrastructure.**

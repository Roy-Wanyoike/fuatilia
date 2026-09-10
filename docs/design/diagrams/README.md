# Design Diagrams (review artifacts)

High-resolution figures from the domain model review that shaped docs/01–08. The lifecycles in
[03 — State machines](../../03-state-machines.md) and the model in [02 — Domain model](../../02-domain-model.md)
are the textual source of truth; these PNGs are the original rendered artifacts.

| File | Figure | Related doc |
|------|--------|-------------|
| `d01_context_map.png` | Bounded-context map (9 contexts, golden rule) | [01](../../01-context-map.md) |
| `d02_money_flow.png` | Corrected money-movement path (resolves C1, C5) | [01](../../01-context-map.md), [06](../../06-review-findings.md) |
| `d03_er_billing.png` | ER cluster — commercial core (Invoice, Receivable, CreditNote, WriteOff, LateFee) | [02](../../02-domain-model.md) |
| `d04_er_payments.png` | ER cluster — money side (Payment, Transaction, Refund, CreditBalance) | [02](../../02-domain-model.md) |
| `d05_er_collections.png` | ER cluster — collections (Case, Action, Promise, Plan, Dispute) | [02](../../02-domain-model.md) |
| `d06_er_recon_ledger.png` | ER cluster — reconciliation & ledger (Match→Payment, exceptions, journal) | [02](../../02-domain-model.md) |
| `d07_er_intel_comms.png` | ER cluster — intelligence & communications (read-only projections, consent) | [02](../../02-domain-model.md) |
| `d08_sm_invoice.png` | Invoice lifecycle (derived financial states) | [03](../../03-state-machines.md) |
| `d09_sm_receivable.png` | Receivable lifecycle (OPEN → SETTLED / WRITTEN_OFF) | [03](../../03-state-machines.md) |
| `d10_sm_payment.png` | Payment lifecycle (refund states from COMPLETED) | [03](../../03-state-machines.md) |
| `d11_sm_case.png` | CollectionCase lifecycle (one open case per receivable, R8) | [03](../../03-state-machines.md) |
| `d12_sm_promise.png` | PromiseToPay lifecycle (F12) | [03](../../03-state-machines.md) |
| `d13_sm_installment.png` | Installment lifecycle (PaymentPlan, F7) | [03](../../03-state-machines.md) |
| `d14_sm_dispute.png` | Dispute lifecycle (F16) | [03](../../03-state-machines.md) |
| `d15_er_ops.png` | ER cluster — ops & platform tables (comms 0011, webhooks 0012, audit/outbox/idempotency 0013, crossborder 0014) | [05](../../05-data-dictionary.md) |

## d15 — ops ER (issue #145)

`d15_er_ops.mmd` is the committed **mermaid source**; `d15_er_ops.png` is the rendered artifact.
Unlike d01–d14 (whose sources were not retained), d15 commits its source so the ERD is diffable
and regenerable. The column/constraint truth for every entity is `db/migrations/0011..0014`,
restated literally in [05 — Data dictionary](../../05-data-dictionary.md); the dictionary's
zero-drift audit against the migration files is the coverage evidence.

Reading notes:

- **Tenant isolation (0001 convention)**: every entity carries `org_id`; children reference their
  parent through the **composite foreign key `(org_id, parent_id)`** against the parent's
  `uq_<table>_org_id` index — cross-tenant linkage is structurally impossible. Only domain roots
  (`conversations`, `webhook_endpoints`, `audit_events`, `idempotency_keys`, `outbox_events`,
  `crossborder_corridors`) draw the `orgs` edge; child tables reach orgs through their parent's
  composite FK.
- **`(logical)` edges** carry no DDL FK: `messages.consent_grant_id` (K2 consent citation, shape
  enforced by `ck_messages_outbound_consent`), `webhook_deliveries.event_id` (domain event;
  uniqueness `(org_id, endpoint_id, event_id)` makes enqueue idempotent),
  `transfer_intents.quote_id` (the snapshot columns, frozen at authorization, carry the R10 truth).

### Regenerating the PNG

The existing d01–d14 pipeline is "mermaid → PNG via mermaid-cli". Reproduce d15 with:

```bash
npx @mermaid-js/mermaid-cli mmdc \
  -i docs/design/diagrams/d15_er_ops.mmd \
  -o docs/design/diagrams/d15_er_ops.png \
  -b white -w 2800 -s 2 \
  -p puppeteer-config.json   # {"args":["--no-sandbox","--disable-gpu"]}
```

Notes from this render: the bundled mermaid build rejects `%%` comments in diagram source (keep
the `.mmd` pure; notes live here), YAML frontmatter must be the first thing in the file, and
`-w 2800 -s 2` is what produced the committed 5568×2280 PNG (default width collapses the layout).
`chrome-headless-shell` must be available to puppeteer (`npx puppeteer browsers install
chrome-headless-shell`).

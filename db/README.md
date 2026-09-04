# db/ — Production PostgreSQL Financial Schema

The authoritative financial store of Fuatilia (ADR-0002: PostgreSQL + the ledger are the
ONLY financial source of truth — Redis, ClickHouse, AI systems and search indexes never
are). The file-backed adapter in `src/adapters/persistence/` remains a dev/store seam.

## Layout

```
db/
├── migrations/        # 0001..0014, forward-only, one file = one atomic transaction
├── pgclient.cjs       # stdlib-only PostgreSQL wire client (the portable server bundle
│                      #   ships no psql; every client-side step goes through this)
├── migrate.cjs        # forward-only runner; suite tracked in schema_migrations;
│                      #   running it twice is a verified no-op
├── exec.cjs           # psql-shaped single-Query CLI over pgclient
├── smoke.cjs          # invariant proof harness — 25 assertions that the constraints FIRE
└── validate.sh        # end-to-end gate: throwaway cluster → migrate ×2 → smoke
```

## Schema map (14 migrations, ~30 tables)

| Migration | Domain | Invariants encoded as DDL |
|---|---|---|
| 0001_orgs | tenant root, shared conventions | composite `(org_id, id)` FK convention — cross-tenant linkage structurally impossible |
| 0002_auth | users, roles, api_keys (hash+prefix), sessions | role_assignments append-only fact ledger; no-self-grant CHECK |
| 0003_customers_consent | customers, contacts, consent_grants (DPA 2019) | consent legal-basis shape |
| 0004_invoicing_receivables | invoices, invoice_items, receivables | frozen draft lines; `balance = original − applied` GENERATED + CHECK ≥ 0 (R1) |
| 0005_payments_matches | payments (c2b/stk), matches | `(org_id, external_ref)` unique; state ⇔ confirmed-amount shape |
| 0006_allocations | allocations | R1 `applied == Σ(active)` + R2 ceiling per source, both DEFERRABLE COMMIT proofs; single-legal-edit reversal stamp (R3); idempotent replay key |
| 0007_adjustments | refunds, credit_notes, customer_credit_balances | ceiling refusals (C2–C4, R6/R7) |
| 0008_ledger | ledger_accounts, posting_matrix, ledger_entries | R3 append-only trigger; R4 Σdebit == Σcredit COMMIT proof; R5/K5 posting whitelist; R10 single currency |
| 0009_collections | cases, case↔receivable links, case_actions | R8 one-open-case-per-receivable via denormalized marker + partial UNIQUE index |
| 0010_promises_plans | promises, payment_plans, installments | fulfilled ≤ promised; H4 Σ(installments) == plan total COMMIT proof |
| 0011_communications | conversations, messages, delivery_attempts | outbound requires a consent_grant reference (K2); append-only retry ladder |
| 0012_webhooks | endpoints, subscriptions, deliveries | https-only, no loopback; `(endpoint_id, event_id)` unique (idempotent enqueue); terminal states frozen; secret hashed |
| 0013_audit_outbox | audit_events, idempotency_keys, outbox_events | §37 append-only audit + per-org hash chain; R9/C5 durable first-write-wins; outbox unique event_id |
| 0014_crossborder | corridors, fx_quotes, transfer_intents | R10 quotes immutable; quote snapshot frozen at authorization; no fund-truth writes |

Every constraint carries an invariant-ID comment (`R1`, `R2`, `R8`, `R9`, `R10`, `K5`, `§37`,
`H4`…) traceable to `docs/07-invariants.md` and the domain lane it mirrors in `src/domain/`.

## Validation (real, not aspirational)

```sh
bash db/validate.sh          # local: boots a throwaway PostgreSQL 16 cluster on :55432
bash db/validate.sh --ci     # CI: runs against a provided postgres service container
```

Gates proven by `validate.sh` (all must print `ALL GATES GREEN`):

1. all migrations apply in order;
2. the second pass is a complete no-op (suite-level idempotency);
3. 25/25 smoke assertions — the invariants actually fire:
   unmapped/unbalanced/append-only ledger refusals (R3/R4/R5), idempotency replay
   (R9), role-assignment and audit immutability, FX snapshot immutability (R10),
   webhook terminal freeze, second-open-case refusal (R8), over-allocation refusal
   (R2) and `applied_minor == Σ(active allocations)` (R1).

Local toolchain: portable PostgreSQL 16.4 binaries live in user space at `$HOME/tools/pgsql`
(no sudo needed); `validate.sh` finds them via `PG_HOME`.

## Migration authoring rules

- Forward-only. NEVER rewrite a shipped migration — append a new one.
- One file = one transaction (the runner wraps it; do not put BEGIN/COMMIT inside).
- New tables follow the house conventions: `timestamptz`, BIGINT minor units (never
  floats), composite org-scoped FKs, deterministic `uq_/ck_/fk_/idx_/trg_` naming,
  invariant-ID comments on every constraint.
- Multi-row batch invariants (sum/ceiling proofs) are DEFERRABLE constraint triggers —
  a row trigger cannot see the whole batch; COMMIT can.

## CI

`.github/workflows/db.yml` runs `db/validate.sh --ci` against a `postgres:16` service
container on every push/PR touching `db/**`. GitHub Actions is currently blocked by the
account billing lock — the workflow activates automatically once billing is resolved, and
until then local `validate.sh` green is the merge gate (`docs/ENGINEERING_STATUS.md`).

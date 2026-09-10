# 05 — Data Dictionary (PostgreSQL, migrations 0001–0015)

Source of truth: [`db/migrations/0001_orgs.sql … 0015_read_model_indexes.sql`](../db/migrations/) —
forward-only, one file = one atomic transaction (`db/migrate.cjs`). This dictionary restates
**every table's columns literally** (snake_case, exact DDL spelling, migration order) so it can be
audited against the migration files mechanically; the per-file coverage/zero-drift table is
reproduced in the dictionary-refresh PR. Column types below are PostgreSQL types (PostgreSQL 16).

ClickHouse is a *designed* analytics projection store (ADR-0002), not provisioned and with no DDL
in the repo — it never holds financial truth and is rebuilt from the event stream. Everything in
this document is the PostgreSQL fund/schema truth.

## Conventions (0001, shared by every later file)

- **Money** is `bigint` minor units, never floats (R10). Every monetary row carries a `currency`
  CHECK restricted to `('KES','USD','GBP','EUR','TZS','UGX')` — the closed currency vocabulary.
- **Timestamps** are `timestamptz`. **Identifiers** are `uuid` with `DEFAULT gen_random_uuid()`.
- **Every table carries `created_at`; mutable tables also carry `updated_at`**, stamped by the
  shared trigger `fuatilia_touch_updated_at()` (0001). Append-only tables (allocations,
  reconciliation_matches, ledger_entries, case_actions, delivery_attempts, audit_events,
  customer_credit_balance_movements) deliberately omit the touch trigger — rows never change, so
  `updated_at === created_at` forever is itself the auditable truth (R3).
- **Tenant isolation**: every org-owned child references its parent through **composite foreign
  keys `(org_id, parent_id)`** against the parent's `uq_<table>_org_id` UNIQUE index on
  `(org_id, id)` — a row can never be linked across tenants (structurally impossible, not
  convention). Every table therefore also carries that `(org_id, id)` UNIQUE index to be an FK
  target; it is listed once per table below as `uq_<table>_org_id` without repetition in notes.
- **Deterministic naming**: `uq_*` (unique), `ck_*` (check), `fk_*` (foreign key), `idx_*`
  (index), `trg_*` (trigger).
- **Invariant tags** reference [07 — Invariants](07-invariants.md): R1–R10, H* (high findings),
  K* (key decisions), C* (corrections), §37 (SPEC audit), AUTH-1.

## Enum types (closed vocabularies)

| Migration | Type | Values |
|---|---|---|
| 0002 | `user_status` | active, suspended, deactivated |
| 0002 | `session_status` | active, ended, expired, revoked |
| 0002 | `api_key_status` | active, revoked |
| 0002 | `role_grant_kind` | grant, revoke |
| 0003 | `consent_channel` | whatsapp, sms, email |
| 0003 | `consent_purpose` | dunning, marketing |
| 0004 | `invoice_status` | draft, issued, sent, voided |
| 0004 | `receivable_state` | draft, open, partially_paid, settled, written_off, recovered, uncollectible, voided |
| 0005 | `payment_channel` | c2b, stk |
| 0005 | `payment_state` | initiated, pending_confirmation, confirmed, partially_allocated, allocated, unapplied, failed, reversed, partially_refunded, refunded |
| 0005 | `match_confidence` | auto, manual |
| 0006 | `allocation_source` | payment, credit_balance |
| 0006 | `allocation_strategy` | fifo, explicit, pro_rata |
| 0007 | `refund_state` | requested, approved, rejected, processing, completed, failed |
| 0007 | `refund_source` | confirmed_funds, credit_balance |
| 0007 | `credit_note_state` | draft, issued, partially_applied, fully_applied, voided |
| 0007 | `cb_movement_kind` | overpayment, credit_note_excess, applied_to_receivable |
| 0007 | `cb_movement_direction` | increase, decrease |
| 0009 | `case_status` | open, in_progress, resolved, closed_inactive |
| 0009 | `case_priority` | low, normal, high, urgent |
| 0010 | `promise_state` | created, pending, partially_fulfilled, fulfilled, broken, cancelled, expired |
| 0010 | `plan_state` | active, completed, defaulted, cancelled |
| 0010 | `installment_state` | scheduled, due, paid, missed, waived |
| 0011 | `comm_channel` | whatsapp, sms, email, ussd |
| 0011 | `comm_direction` | outbound, inbound, system |
| 0011 | `message_state` | queued, sent, delivered, failed, dead_lettered |
| 0012 | `webhook_state` | queued, delivering, delivered, failed, dead_lettered |
| 0014 | `transfer_intent_state` | drafted, quoted, authorized, submitted, settled, cancelled |

## 0001_orgs — tenant root

### `orgs`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` — tenant root |
| `name` | text | NN | `ck_orgs_name_nonblank` (btrim ≥ 1) |
| `slug` | text | NN | `ck_orgs_slug_nonblank`; **U** `uq_orgs_slug(slug)` — URL/login-stable handle |
| `status` | text | NN | `'active'`; `ck_orgs_status` IN (active, suspended, closed) |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- FKs: none (root). Trigger: none beyond conventions.
- Also defined here: `fuatilia_touch_updated_at()` — the shared updated_at trigger used by all
  mutable tables.

## 0002_auth — identity & access

### `users`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `email` | text | NN | `ck_users_email_nonblank` (contains `@`); **U** `uq_users_org_email(org_id, email)` |
| `username` | text | NN | `ck_users_username_nonblank` (btrim ≥ 3); **U** `uq_users_org_username(org_id, username)` |
| `display_name` | text | NN | `ck_users_display_nonblank` |
| `status` | user_status | NN | `'active'` — active / suspended / deactivated |
| `password_hash` | text | NN | password **verifier digest only** — plaintext secrets never touch this schema |
| `suspended_at` | timestamptz | – | |
| `suspended_reason` | text | – | |
| `reactivated_at` | timestamptz | – | |
| `deactivated_at` | timestamptz | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- FKs: `org_id → orgs(id)`. `uq_users_org_id(org_id, id)` is the composite-FK target for sessions,
  role_assignments, api_keys.
- Indexes: `idx_users_status(org_id, status)` (suspension cascade lookups).

### `roles`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `name` | text | NN | `ck_roles_name_nonblank`; **U** `uq_roles_org_name(lower(name), org_id)` |
| `permissions` | text[] | NN | `ck_roles_permissions_nonempty` (cardinality ≥ 1) — sorted, validated vocabulary |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

### `role_assignments`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `kind` | role_grant_kind | NN | `grant` or `revoke` — the append-only fact ledger (R3) |
| `user_id` | uuid | NN | composite FK `fk_role_assignments_user(org_id, user_id) → users` |
| `role_id` | uuid | NN | composite FK `fk_role_assignments_role(org_id, role_id) → roles` |
| `resource_id` | uuid | – | NULL = org-wide grant; else scoped to exactly one resource |
| `granted_by` | uuid | NN | composite FK `fk_role_assignments_granter(org_id, granted_by) → users` |
| `granted_at` | timestamptz | NN | `now()` |
| `revoked_grant_id` | uuid | – | revoke rows only; composite self-FK `fk_role_assignments_revoked` |
| `revoked_at` | timestamptz | – | revoke rows only |
| `revoked_by` | uuid | – | revoke rows only |
| `revoked_reason` | text | – | revoke rows only |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` (row never actually edited — append-only) |

- **Append-only (R3)**: `trg_role_assignments_append_only` rejects UPDATE/DELETE — grants AND
  revocations are INSERTed as facts; "latest fact wins" is a query, not an edit.
- **AUTH-1 no-self-escalation**: `ck_role_assignments_no_self_grant` — `granted_by <> user_id` on
  grant rows (revoking your own grant is a demotion and stays legal).
- Fact-shape CHECKs: `ck_role_assignments_grant_shape` (grants carry no revocation),
  `ck_role_assignments_revoke_shape` (revokes carry all four revocation columns).
- `trg_role_assignments_validate_revoke`: revoke target must be a **grant** of the same
  org/user/role and not already revoked (no double revocation) — a CHECK cannot express the
  partial predicate, the trigger covers it.
- Indexes: `idx_role_assignments_user(org_id, user_id, kind)` (guard.ts effectivePermissions),
  `idx_role_assignments_role(org_id, role_id)`; plus `idx_role_assignments_revoked_grant`
  (0015, partial on `revoked_grant_id IS NOT NULL`) for the auth anti-join hot path.

### `api_keys`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `key_id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `name` | text | NN | `ck_api_keys_name_nonblank` |
| `created_by` | uuid | NN | issuer; composite FK `fk_api_keys_issuer(org_id, created_by) → users` |
| `prefix` | text | NN | visible 8-char prefix (`ck_api_keys_prefix_len`); **NOT a secret** — lookup key |
| `secret_hash` | text | NN | codec digest (`ck_api_keys_hash_nonblank` ≥ 16); plaintext never stored |
| `scopes` | text[] | NN | `ck_api_keys_scopes_nonempty` — deduped, sorted permissions |
| `expires_at` | timestamptz | – | |
| `status` | api_key_status | NN | `'active'` |
| `created_at` | timestamptz | NN | `now()` |
| `last_used_at` | timestamptz | – | |
| `revoked_at` | timestamptz | – | |
| `revoked_by` | uuid | – | |
| `revoked_reason` | text | – | |
| `updated_at` | timestamptz | NN | `now()` |

- Revocation is a fact, immutably shaped: `ck_api_keys_revocation_shape` —
  `(status = 'revoked') = (revoked_at IS NOT NULL)`.
- Index: `idx_api_keys_prefix(org_id, prefix)` — auth looks up by visible prefix, verifies hash.

### `sessions`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `session_id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `user_id` | uuid | NN | composite FK `fk_sessions_user(org_id, user_id) → users` |
| `idle_timeout_ms` | bigint | NN | `ck_sessions_timeouts_positive` (> 0) |
| `absolute_timeout_ms` | bigint | NN | `ck_sessions_timeouts_positive` (> 0) |
| `status` | session_status | NN | `'active'` — active / ended / expired / revoked |
| `created_at` | timestamptz | NN | `now()` |
| `last_seen_at` | timestamptz | NN | `now()` |
| `ended_at` | timestamptz | – | |
| `ended_reason` | text | – | |
| `updated_at` | timestamptz | NN | `now()` |

- `ck_sessions_end_shape`: `(status = 'active') = (ended_at IS NULL)` — an ended/expired/revoked
  session always carries its end instant.
- Indexes: `idx_sessions_user_status(org_id, user_id, status)`,
  `idx_sessions_last_seen(status, last_seen_at)` (idle-expiry sweeps).

## 0003_customers_consent — customers, contacts, DPA 2019 consent

### `customers`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `display_name` | text | NN | `ck_customers_name_nonblank` |
| `msisdn` | text | – | primary phone (Safaricom format); **U** `uq_customers_org_msisdn` WHERE `msisdn IS NOT NULL` (one wallet = one customer per org) |
| `email` | text | – | |
| `segment` | text | – | collections segmentation input |
| `risk_tier` | text | NN | `'standard'` |
| `status` | text | NN | `'active'`; `ck_customers_status` IN (active, blocked, archived) |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- `ck_customers_channel_present`: `msisdn IS NOT NULL OR email IS NOT NULL` — a customer nobody
  can reach cannot be dunned, invoiced or refunded.
- Index: `idx_customers_status(org_id, status)`.

### `contacts`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_contacts_customer(org_id, customer_id) → customers` |
| `kind` | text | NN | `ck_contacts_kind` IN (phone, email, whatsapp, postal) |
| `value` | text | NN | `ck_contacts_value_nonblank` |
| `is_primary` | boolean | NN | `false` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **U** `uq_contacts_primary(org_id, customer_id, kind) WHERE is_primary` — exactly one primary
  contact per channel kind (deterministic addressing).
- Index: `idx_contacts_customer(org_id, customer_id)`.

### `consent_grants`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_consent_customer(org_id, customer_id) → customers` |
| `channel` | consent_channel | NN | whatsapp / sms / email |
| `purpose` | consent_purpose | NN | dunning / marketing |
| `granted_at` | timestamptz | NN | `now()` |
| `revoked_at` | timestamptz | – | stamped **exactly once** (K2/DPA 2019: grant + withdrawal both provable) |
| `lawful_basis` | text | NN | `'consent'`; `ck_consent_lawful_basis` IN (consent, contract, legitimate_interest) |
| `evidence_ref` | text | – | pointer to captured consent evidence (UI flow / signed record) — the DPA audit hook |
| `dpa_version` | text | NN | `'kenya-dpa-2019'` — regulation pinning |
| `expires_at` | timestamptz | – | purpose limitation (DPA 2019 s.25); NULL = no policy-driven expiry |
| `granted_by` | text | – | actor/agent that captured the consent |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- `ck_consent_revoke_after_grant` (withdrawal cannot precede the grant), `ck_consent_expiry_after_grant`.
- **Revoke-once** (K2/DPA): `trg_consent_revoke_once` — the single legal edit is stamping
  `revoked_at` NULL → NOT NULL with every other column byte-identical; a second stamp raises
  `CONSENT_ALREADY_REVOKED`.
- Indexes: `idx_consent_active_lookup(org_id, customer_id, channel, purpose) WHERE revoked_at IS NULL`
  — **the K2 dunning gate** (a message may only be sent under an ACTIVE grant);
  `idx_consent_customer_history(org_id, customer_id, granted_at DESC)`.

## 0004_invoicing_receivables — the commercial core

### `invoices`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_invoices_customer(org_id, customer_id) → customers` |
| `status` | invoice_status | NN | `'draft'` — draft / issued / sent / voided |
| `currency` | text | NN | closed 6-currency CHECK `ck_invoices_currency` (R10) |
| `total_minor` | bigint | NN | `0`; `ck_invoices_total_nonneg` (≥ 0); = Σ(line items) proven at COMMIT by `trg_invoice_items_sum_check` (deferrable); frozen at issuance |
| `invoice_number` | text | – | eTIMS-reserved (KRA) number; `(status = 'draft') = (invoice_number IS NULL)`; **U** `uq_invoices_org_number` WHERE NOT NULL |
| `issued_at` | timestamptz | – | |
| `due_date` | timestamptz | NN | |
| `sent_at` | timestamptz | – | |
| `sent_channel` | text | – | |
| `voided_at` | timestamptz | – | |
| `void_reason` | text | – | |
| `voided_by` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- `ck_invoices_void_shape`: voiding is a decision — voided requires `void_reason` AND `voided_by`
  AND `voided_at`.
- Corrections after issuance go through **credit notes, never edits**; line edits are rejected
  once the invoice leaves draft: `trg_invoice_items_frozen_guard` raises `INVOICE_LINES_FROZEN`
  (docs/03) on INSERT/UPDATE/DELETE of `invoice_items` for a non-draft invoice.
- Indexes: `idx_invoices_customer`, `idx_invoices_due_date(org_id, due_date)`.

### `invoice_items`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `invoice_id` | uuid | NN | composite FK `fk_invoice_items_invoice(org_id, invoice_id) → invoices` |
| `line_no` | integer | NN | `ck_invoice_items_line_no` (≥ 1); **U** `uq_invoice_items_line(org_id, invoice_id, line_no)` |
| `description` | text | NN | `ck_invoice_items_desc_nonblank` |
| `amount_minor` | bigint | NN | `ck_invoice_items_amount_pos` (> 0) — positive lines only |
| `currency` | text | NN | closed 6-currency CHECK — a line cannot be in a foreign currency (R10) |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Guarded by `trg_invoice_items_frozen_guard` (lines frozen on non-draft invoices) and
  `trg_invoice_items_sum_check` (Σ lines = `invoices.total_minor` at COMMIT).

### `receivables`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `invoice_id` | uuid | NN | composite FK `fk_receivables_invoice(org_id, invoice_id) → invoices`; **U** `uq_receivables_org_invoice` — exactly ONE receivable per invoice |
| `customer_id` | uuid | NN | composite FK `fk_receivables_customer(org_id, customer_id) → customers` |
| `currency` | text | NN | closed 6-currency CHECK (R10) |
| `original_minor` | bigint | NN | `ck_receivables_original_nonneg` (≥ 0); **frozen at open** — `trg_receivables_frozen_fields` |
| `applied_minor` | bigint | NN | `0`; `ck_receivables_applied_nonneg`; maintained by `trg_allocations_sync_receivable` (0006) to equal Σ(active allocations) |
| `balance_minor` | bigint | NN | **GENERATED ALWAYS AS (original_minor − applied_minor) STORED**; `ck_receivables_balance_nonneg` (≥ 0) — [R1] holds structurally |
| `state` | receivable_state | NN | `'draft'` — draft / open / partially_paid / settled / written_off / recovered / uncollectible / voided |
| `overdue` | boolean | NN | `false`; `ck_receivables_overdue_scope` — only true while state IN (open, partially_paid) |
| `opened_at` | timestamptz | – | |
| `due_date` | timestamptz | NN | `ck_receivables_due_date_present`; frozen at open |
| `settled_at` | timestamptz | – | |
| `voided_at` | timestamptz | – | |
| `write_off_reason` | text | – | [H1] mandatory when state = written_off |
| `write_off_approved_by` | text | – | [H1] mandatory when state = written_off |
| `write_off_at` | timestamptz | – | |
| `uncollectible_reason` | text | – | mandatory when state = uncollectible |
| `uncollectible_at` | timestamptz | – | |
| `recovered_at` | timestamptz | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **[R1]** `settled ⇔ fully applied`: `ck_receivables_settled_zero` — state='settled' requires
  `balance_minor = 0`; voiding requires zero applied funds (`ck_receivables_void_zero_applied`).
- **[H1]** `ck_receivables_writeoff_shape`: a write-off decision carries reason AND approver;
  `ck_receivables_uncollectible_shape` records the verdict reason.
- **FROZEN identity**: `trg_receivables_frozen_fields` — invoice/customer/currency/original/due
  date never change after creation.
- Indexes: `idx_receivables_state`, `idx_receivables_customer`,
  `idx_receivables_live_due(org_id, due_date) WHERE state IN (open, partially_paid)` (the aging
  scan), `idx_receivables_live_overdue` (overdue live debt); plus `idx_receivables_org_created`,
  `idx_receivables_org_due` (0015 list pagination).

## 0005_payments_matches — fund truth for inflows

### `payments`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | – | NULL until identified (unapplied parking, C4); composite FK `fk_payments_customer` |
| `channel` | payment_channel | NN | c2b / stk |
| `external_ref` | text | NN | Daraja transaction id (K1); `ck_payments_external_ref` nonblank; **U** `uq_payments_org_external_ref(org_id, external_ref)` — [R9/C5] idempotent intake |
| `idempotency_key` | text | NN | caller-supplied; `ck_payments_idem_key` nonblank; **U** `uq_payments_org_idem_key(org_id, idempotency_key)` — [R9] |
| `state` | payment_state | NN | `'initiated'` — initiated / pending_confirmation / confirmed / partially_allocated / allocated / unapplied / failed / reversed / partially_refunded / refunded |
| `currency` | text | NN | closed 6-currency CHECK (R10) |
| `requested_minor` | bigint | NN | what was asked for at intake (E11); `ck_payments_requested_nonneg` (≥ 0) |
| `confirmed_minor` | bigint | – | set EXACTLY ONCE at confirmation, never mutated; `ck_payments_confirmed_pos` (> 0) |
| `unapplied_minor` | bigint | – | maintained derivation: confirmed − Σ(active allocations) − Σ(refunds) |
| `declared_refs` | text[] | NN | `'{}'` — payer-entered references |
| `initiated_at` | timestamptz | NN | `now()` |
| `confirmed_at` | timestamptz | – | |
| `failed_at` | timestamptz | – | |
| `failure_code` | text | – | |
| `reversed_at` | timestamptz | – | |
| `reversal_reason` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **[R2/R6 frame]** `ck_payments_state_confirmed_shape`: the confirmed family
  (confirmed / partially_allocated / allocated / unapplied / partially_refunded / refunded /
  reversed) ⇔ `confirmed_minor IS NOT NULL`. `ck_payments_failed_shape` (failed ⇔ failed_at),
  `ck_payments_reversal_shape` (reversed ⇔ reversed_at — a reasoned decision, R3).
- A replayed Daraja callback finds this row via `uq_payments_org_external_ref` instead of creating
  money (R9/C5).
- Indexes: `idx_payments_state`, `idx_payments_initiated_at`, `idx_payments_customer`,
  `idx_payments_unapplied(org_id, state, unapplied_minor) WHERE state IN (confirmed, unapplied,
  partially_allocated)` (unapplied parking sweeps, C4); plus `idx_payments_org_created`,
  `idx_payments_org_initiated` (0015 list pagination).

### `reconciliation_matches`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `payment_id` | uuid | NN | composite FK `fk_matches_payment(org_id, payment_id) → payments` — **[R5] the ONLY target** (C1 fix); N receivables per payment is expressed through allocations |
| `declared_refs` | text[] | NN | `'{}'` — payer-typed invoice/receipt refs, may be fuzzy |
| `confidence` | match_confidence | NN | auto / manual |
| `matched_at` | timestamptz | NN | `now()` |
| `matched_by` | text | – | |
| `reversal_of` | uuid | – | [R3] correcting row points at the match it undoes; self-FK `fk_matches_reversal` |
| `reason` | text | – | `ck_matches_reversal_reason` — a correction must say why and cannot target itself |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` (row never edited — append-only) |

- **Append-only (R3)**: `trg_matches_append_only` — a reversal appends a new row with
  `reversal_of`, never edits.
- Indexes: `idx_matches_payment(org_id, payment_id)`, `idx_matches_reversal_of`.

## 0006_allocations — postings moving value

### `allocations`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `source_type` | allocation_source | NN | payment / credit_balance — the typed source pair |
| `source_payment_id` | uuid | – | set ⇔ `source_type = 'payment'`; FK `fk_allocations_payment → payments` |
| `source_credit_customer_id` | uuid | – | set ⇔ `source_type = 'credit_balance'`; FK `fk_allocations_credit_cust → customers` |
| `source_id` | uuid | NN | coalescing alias; `ck_allocations_source_id_link` = COALESCE(payment, credit customer) — drift-proof |
| `receivable_id` | uuid | NN | composite FK `fk_allocations_receivable(org_id, receivable_id) → receivables` |
| `amount_minor` | bigint | NN | `ck_allocations_amount_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK (R10) |
| `strategy` | allocation_strategy | NN | `'fifo'` — fifo / explicit / pro_rata [H3] |
| `sequence_no` | bigint | NN | `ck_allocations_seq` (≥ 1); **U** `uq_allocations_replay(org_id, source_type, source_id, sequence_no)` — idempotent replay |
| `allocated_at` | timestamptz | NN | `now()` |
| `reversed_at` | timestamptz | – | [R3] the single mutable instant: stamped once when reversed |
| `reversal_of` | uuid | – | [R3] set on a COMPENSATING row (self-FK `fk_allocations_reversal`; cannot target itself) |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` (only `reversed_at` is ever stamped) |

- **[R3] single-legal-edit**: `trg_allocations_guard` — DELETE rejected; the only UPDATE is
  `reversed_at` NULL → NOT NULL with every other column identical; corrections append
  compensating rows.
- **[R1]** `trg_allocations_sync_receivable` recomputes `receivables.applied_minor` from ACTIVE
  rows (`reversed_at IS NULL AND reversal_of IS NULL`); `trg_allocations_check_r1` (DEFERRABLE,
  COMMIT) re-proves stored = Σ(active) and Σ ≤ original — over-allocation trips
  `ck_receivables_balance_nonneg` (0004) immediately.
- **[R2]** `trg_allocations_check_r2` (DEFERRABLE, COMMIT): Σ(active allocations of one source)
  ≤ source funds — `payments.confirmed_minor` or the customer's `available_minor`; batch-safe
  (rows that individually fit but jointly overdraw are rejected at COMMIT).
- Indexes: `idx_allocations_receivable` (partial, live rows), `idx_allocations_payment` (partial),
  `idx_allocations_credit` (partial); plus `idx_allocations_payment_live` (0015, ordered
  allocated_at scan for payment detail + the R6 ceiling input).

## 0007_adjustments — refunds, credit notes, credit balances

### `customer_credit_balances`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `org_id` | uuid | NN | FK → `orgs(id)`; **PK part** |
| `customer_id` | uuid | NN | composite FK `fk_ccb_customer(org_id, customer_id) → customers`; **PK part** |
| `currency` | text | NN | closed 6-currency CHECK `ck_ccb_currency`; **PK part** — one balance per currency [C4] |
| `available_minor` | bigint | NN | `0`; `ck_ccb_available_nonneg` (≥ 0); maintained by `trg_ccbm_apply_movement` from the append-only log |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **PK (org_id, customer_id, currency)** — the composite PK IS the one-balance-per-currency rule (C4).
- `trg_ccbm_check_consistency` (DEFERRABLE, COMMIT): stored balance = Σ(movements), never < 0
  (`CREDIT_BALANCE_DRIFT` / `INSUFFICIENT_CREDIT_BALANCE`).

### `customer_credit_balance_movements`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_ccbm_customer(org_id, customer_id) → customers` |
| `currency` | text | NN | closed 6-currency CHECK `ck_ccbm_currency` |
| `kind` | cb_movement_kind | NN | overpayment / credit_note_excess / applied_to_receivable |
| `direction` | cb_movement_direction | NN | increase / decrease — the sign lives here, never in the amount |
| `amount_minor` | bigint | NN | `ck_ccbm_amount_pos` (> 0) |
| `source_payment_ref` | text | – | required when kind = overpayment (Daraja ref or id) |
| `source_credit_note_id` | uuid | – | required when kind = credit_note_excess; FK `fk_ccbm_note → credit_notes` (R7 consented routing) |
| `receivable_id` | uuid | – | required when kind = applied_to_receivable |
| `occurred_at` | timestamptz | NN | `now()` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` (row never edited) |

- **[C4] MOVEMENT_CONTRACT as DDL**: `ck_ccbm_contract_overpayment` (overpayment ⇒ increase +
  payment ref), `ck_ccbm_contract_note_excess` (note excess ⇒ increase + note id),
  `ck_ccbm_contract_applied` (applied ⇒ decrease + receivable).
- **[R3]** `trg_ccbm_append_only` — immutable log; corrections append the opposite movement.
  `trg_ccbm_apply_movement` upserts the balance; `trg_ccbm_check_consistency` proves it at COMMIT.
- Indexes: `idx_ccbm_customer(org_id, customer_id, occurred_at)`,
  `idx_ccbm_note_source` (partial — the R7 ceiling input).

### `refunds`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `payment_id` | uuid | NN | composite FK `fk_refunds_payment(org_id, payment_id) → payments` — [C2] refunds never float free of their payment |
| `requested_by` | text | NN | `ck_refunds_requester` nonblank |
| `reason` | text | NN | `ck_refunds_reason` nonblank |
| `state` | refund_state | NN | `'requested'` — requested / approved / rejected / processing / completed / failed |
| `total_minor` | bigint | NN | `ck_refunds_total_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK `ck_refunds_currency` |
| `external_ref` | text | – | current Daraja B2C ref; **U** `uq_refunds_org_external_ref` WHERE NOT NULL — every retry uses a NEW ref |
| `rejected_reason` | text | – | |
| `failed_reason` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **[R6]** `trg_refunds_check_r6` (DEFERRABLE, COMMIT):
  `total_minor ≤ confirmed − Σ(active allocations) − Σ(live refunds other than this one)`;
  rejected/failed attempts release their reservation. Indexes: `idx_refunds_payment`,
  `idx_refunds_state`.

### `refund_allocations`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `refund_id` | uuid | NN | composite FK `fk_refund_allocations_refund(org_id, refund_id) → refunds` |
| `source` | refund_source | NN | confirmed_funds / credit_balance |
| `amount_minor` | bigint | NN | `ck_refund_allocations_amount_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- `trg_refund_allocations_sum_check` (DEFERRABLE, COMMIT): Σ(refund_allocations) =
  `refunds.total_minor`. Index: `idx_refund_allocations_refund`.

### `credit_notes`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_credit_notes_customer(org_id, customer_id) → customers` |
| `invoice_id` | uuid | – | optional invoice linkage; FK `fk_credit_notes_invoice → invoices` |
| `reason` | text | NN | `ck_credit_notes_reason` nonblank |
| `total_minor` | bigint | NN | `ck_credit_notes_total_pos` (> 0); frozen at draft (docs/05) |
| `currency` | text | NN | closed 6-currency CHECK `ck_credit_notes_currency` |
| `state` | credit_note_state | NN | `'draft'` — draft / issued / partially_applied / fully_applied / voided |
| `issued_at` | timestamptz | – | |
| `voided_at` | timestamptz | – | `ck_credit_notes_void_shape` — void only while nothing applied |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Indexes: `idx_credit_notes_customer`, `idx_credit_notes_state`.

### `credit_note_applications`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `credit_note_id` | uuid | NN | composite FK `fk_cna_note(org_id, credit_note_id) → credit_notes` |
| `receivable_id` | uuid | NN | composite FK `fk_cna_receivable(org_id, receivable_id) → receivables` |
| `amount_minor` | bigint | NN | `ck_cna_amount_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK `ck_cna_currency` |
| `applied_at` | timestamptz | NN | `now()` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **[R7]** `trg_cna_check_r7` (DEFERRABLE, COMMIT): Σ applications + Σ consented credit-balance
  routings sourced from the note ≤ `credit_notes.total_minor`. Indexes: `idx_cna_note`,
  `idx_cna_receivable`.

## 0008_ledger — immutable double-entry fund truth

### `ledger_accounts`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `code` | text | NN | `ck_ledger_accounts_code_nonblank`; **U** `uq_ledger_accounts_code(org_id, code)` |
| `name` | text | NN | `ck_ledger_accounts_name_nonblank` |
| `kind` | text | NN | `ck_ledger_accounts_kind` IN (asset, liability, equity, income, expense) |
| `currency` | text | NN | closed 6-currency CHECK |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

### `posting_matrix`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `source` | text | NN | posting source (the command that moves money) |
| `debit_kind` | text | NN | account KIND: asset / liability / equity / income / expense |
| `credit_kind` | text | NN | account KIND: asset / liability / equity / income / expense |
| `created_at` | timestamptz | NN | `now()` (no updated_at — seeded deployer config) |

- **[K5/R5]** the whitelist of legal (source, debit-kind → credit-kind) postings; **U**
  `uq_posting_matrix(org_id, source, debit_kind, credit_kind)` — unmapped postings are refused at
  COMMIT by `trg_ledger_entries_check_r4` (see posting matrix below).

### `ledger_entries`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `entry_id` | uuid | NN | groups the debit/credit lines of ONE entry |
| `line_no` | integer | NN | `ck_ledger_entries_line` (≥ 1); **U** `uq_ledger_entries_replay(org_id, journal_ref, line_no)` — idempotent replay |
| `account_id` | uuid | NN | composite FK `fk_ledger_entries_account(org_id, account_id) → ledger_accounts` |
| `direction` | text | NN | `ck_ledger_entries_direction` IN (debit, credit) |
| `amount_minor` | bigint | NN | `ck_ledger_entries_amount_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK; `trg_ledger_entries_guard` refuses a mixed-currency entry [R10] |
| `source` | text | NN | posting source — must be mapped in `posting_matrix` [R5/K5] |
| `source_ref` | text | – | domain pointer (payment/adjustment id…) |
| `journal_ref` | text | NN | the journal batch the line belongs to |
| `posted_at` | timestamptz | NN | `now()` |
| `reversal_of` | uuid | – | compensating entry linkage; self-FK `fk_ledger_entries_reversal`; cannot target itself |
| `created_at` | timestamptz | NN | `now()` (NO updated_at — append-only table) |

- **[R3]** `trg_ledger_entries_guard`: UPDATE and DELETE rejected outright; corrections append
  compensating entries with `reversal_of`.
- **[R4/R5]** `trg_ledger_entries_check_r4` (DEFERRABLE, COMMIT): Σ(debit) = Σ(credit) for the
  whole entry in ONE currency, and every (debit-kind → credit-kind) pair is whitelisted by
  `posting_matrix` for the entry's source. No cent is created or destroyed.
- Indexes: `idx_ledger_entries_entry`, `idx_ledger_entries_account(org_id, account_id, posted_at)`,
  `idx_ledger_entries_journal`.

## 0009_collections — the work queue

### `collections_cases`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `case_number` | text | NN | `ck_collections_cases_number_nonblank`; **U** `uq_collections_cases_number(org_id, case_number)` |
| `priority` | case_priority | NN | `'normal'` — low / normal / high / urgent |
| `status` | case_status | NN | `'open'` — open / in_progress / resolved / closed_inactive |
| `owner_id` | uuid | NN | assigned collector |
| `next_action` | text | – | |
| `next_action_at` | timestamptz | – | |
| `opened_at` | timestamptz | NN | `now()` (frozen — identity) |
| `closed_at` | timestamptz | – | `ck_collections_cases_closed_shape` — closed ⇔ closed_at present |
| `closed_reason` | text | – | `ck_collections_cases_closed_reason` — only on closed statuses |
| `sequence_no` | bigint | NN | `ck_collections_cases_seq` (≥ 1); **U** `uq_collections_cases_seq(org_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **Append-mostly**: `trg_collections_cases_guard` freezes `case_number` / `sequence_no` /
  `opened_at` after creation; only status/priority/owner/next-action evolve.
- Index: `idx_collections_cases_open(org_id, status, priority) WHERE status IN (open,
  in_progress)`; plus `idx_collections_cases_org_created` (0015 list pagination).

### `collections_case_receivables`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `case_id` | uuid | NN | composite FK `fk_collections_case_rec_case(org_id, case_id) → collections_cases` **ON DELETE CASCADE** |
| `receivable_id` | uuid | NN | composite FK `fk_collections_case_rec_rec(org_id, receivable_id) → receivables` |
| `open_receivable_id` | uuid | – | [R8] denormalized marker: `receivable_id` while the covering case is open, else NULL |
| `created_at` | timestamptz | NN | `now()` |

- **U** `ck_collections_case_rec_unique(org_id, case_id, receivable_id)` (inline constraint).
- **[R8]** **U** `uq_r8_one_open_case_per_receivable(org_id, open_receivable_id) WHERE
  open_receivable_id IS NOT NULL` — CASE_ALREADY_OPEN as DDL: a second open case for the same
  receivable is structurally impossible under concurrency. Markers are maintained by
  `trg_case_rec_r8_marker` (on link insert) and `trg_case_r8_marker_sync` (on case status change).

### `case_actions`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `case_id` | uuid | NN | composite FK `fk_case_actions_case(org_id, case_id) → collections_cases` |
| `actor_id` | text | NN | `ck_case_actions_actor_nonblank` — actor required on every step |
| `action` | text | NN | `ck_case_actions_action_nonblank` |
| `detail` | jsonb | NN | `'{}'::jsonb` |
| `performed_at` | timestamptz | NN | `now()` |
| `sequence_no` | bigint | NN | `ck_case_actions_seq` (≥ 1); **U** `uq_case_actions_seq(org_id, case_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` (NO updated_at — append-only) |

- **Append-only**: `trg_case_actions_guard` rejects UPDATE/DELETE — the case timeline is never
  edited or deleted. Index: `idx_case_actions_case(org_id, case_id, performed_at)`.

## 0010_promises_plans — promises & structured repayment

### `promises`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_promises_customer(org_id, customer_id) → customers` |
| `receivable_id` | uuid | – | optional receivable focus (soft reference — no DDL FK; the 0015 promise-overlay index keys on it) |
| `promised_minor` | bigint | NN | `ck_promises_amount_pos` (> 0) |
| `currency` | text | NN | closed 6-currency CHECK `ck_promises_currency` |
| `state` | promise_state | NN | `'created'` — created / pending / partially_fulfilled / fulfilled / broken / cancelled / expired |
| `promised_for` | timestamptz | NN | when the customer promised to pay |
| `fulfilled_minor` | bigint | NN | `0`; `ck_promises_fulfilled_nonneg` (≥ 0) and `ck_promises_fulfilled_bounds` (≤ promised_minor) |
| `broken_at` | timestamptz | – | `ck_promises_broken_shape` — broken ⇔ broken_at present; terminal states freeze |
| `sequence_no` | bigint | NN | `ck_promises_seq` (≥ 1); **U** `uq_promises_seq(org_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Indexes: `idx_promises_customer(org_id, customer_id, promised_for)`,
  `idx_promises_open(org_id, state) WHERE state IN (created, pending, partially_fulfilled)`;
  plus `idx_promises_receivable_open` (0015, case-detail pending-promise overlay).

### `payment_plans`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `customer_id` | uuid | NN | composite FK `fk_payment_plans_customer(org_id, customer_id) → customers` |
| `receivable_id` | uuid | NN | composite FK `fk_payment_plans_receivable(org_id, receivable_id) → receivables` |
| `total_minor` | bigint | NN | `ck_payment_plans_total_pos` (> 0); = Σ(installments) proven at COMMIT [H4] |
| `currency` | text | NN | closed 6-currency CHECK `ck_payment_plans_currency` |
| `state` | plan_state | NN | `'active'` — active / completed / defaulted / cancelled |
| `frequency` | text | NN | `ck_payment_plans_frequency` IN (weekly, biweekly, monthly) |
| `grace_days` | integer | NN | `0`; `ck_payment_plans_grace` (≥ 0) |
| `started_at` | timestamptz | NN | |
| `completed_at` | timestamptz | – | `ck_payment_plans_completed_shape` — completed ⇔ completed_at present |
| `sequence_no` | bigint | NN | `ck_payment_plans_seq` (≥ 1); **U** `uq_payment_plans_seq(org_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Index: `idx_payment_plans_customer(org_id, customer_id, state)`.

### `installments`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `plan_id` | uuid | NN | composite FK `fk_installments_plan(org_id, plan_id) → payment_plans` |
| `installment_no` | integer | NN | `ck_installments_no` (≥ 1); **U** `uq_installments_plan(org_id, plan_id, installment_no)` (inline) |
| `due_date` | date | NN | schedule due date (DATE, not ts — day granularity) |
| `amount_minor` | bigint | NN | `ck_installments_amount_pos` (> 0) |
| `state` | installment_state | NN | `'scheduled'` — scheduled / due / paid / missed / waived |
| `paid_minor` | bigint | NN | `0`; `ck_installments_paid_nonneg` (≥ 0), `ck_installments_paid_bounds` (≤ amount_minor) |
| `paid_at` | timestamptz | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- `ck_installments_paid_shape`: unless paid/missed/waived, `paid_minor = 0 AND paid_at IS NULL`.
- **[H4]** `trg_installments_check_sum` (DEFERRABLE, COMMIT): Σ(installment amounts) =
  `payment_plans.total_minor` — the deterministic schedule guarantee. Index:
  `idx_installments_due(org_id, due_date) WHERE state = 'scheduled'`.

## 0011_communications — conversations & delivery

### `conversations`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)`; **U** `uq_conversations_org(org_id, id)` (inline) |
| `customer_id` | uuid | NN | composite FK `fk_conversations_customer(org_id, customer_id) → customers` |
| `channel` | comm_channel | NN | whatsapp / sms / email / ussd |
| `subject` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Index: `idx_conversations_customer(org_id, customer_id, created_at)`.

### `messages`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `conversation_id` | uuid | NN | composite FK `fk_messages_conversation(org_id, conversation_id) → conversations` |
| `direction` | comm_direction | NN | outbound / inbound / system |
| `channel` | comm_channel | NN | whatsapp / sms / email / ussd |
| `recipient` | text | NN | `ck_messages_recipient_nonblank` |
| `body` | text | NN | `ck_messages_body_nonblank` |
| `state` | message_state | NN | `'queued'` — queued / sent / delivered / failed / dead_lettered |
| `template_key` | text | – | `ck_messages_template_shape` — template key and version are all-or-nothing |
| `template_version` | integer | – | the exact template version the message used (versioned templates) |
| `consent_grant_id` | uuid | – | **[K2]** outbound rows MUST cite the consent grant they relied on (`ck_messages_outbound_consent`); logical reference to `consent_grants(id)` — no DDL FK; nullable only for inbound/system rows |
| `provider_ref` | text | – | provider message id |
| `error_code` | text | – | |
| `sequence_no` | bigint | NN | `ck_messages_seq` (≥ 1); **U** `uq_messages_seq(org_id, conversation_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Indexes: `idx_messages_conversation(org_id, conversation_id, created_at)`,
  `idx_messages_state(org_id, state) WHERE state IN (queued, failed)` (retry sweeps).

### `delivery_attempts`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `message_id` | uuid | NN | composite FK `fk_delivery_attempts_message(org_id, message_id) → messages` |
| `attempt_no` | integer | NN | `ck_delivery_attempts_no` (≥ 1); **U** `uq_delivery_attempts(org_id, message_id, attempt_no)` (inline) |
| `outcome` | text | NN | `ck_delivery_attempts_outcome` IN (success, failure) |
| `provider_ref` | text | – | |
| `error_code` | text | – | |
| `latency_ms` | integer | – | |
| `attempted_at` | timestamptz | NN | `now()` |

- **Append-only retry ladder** (K2): `trg_delivery_attempts_guard` — retries append rows, never
  edit history. Index: `idx_delivery_attempts_message(org_id, message_id, attempt_no)`.

## 0012_webhooks — endpoint registry & delivery lifecycle

### `webhook_endpoints`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `url` | text | NN | `ck_webhook_endpoints_https` (`^https://`) + `ck_webhook_endpoints_no_local` (no localhost/loopback targets) |
| `description` | text | – | |
| `secret_hash` | text | NN | signing secret stored HASHED — plaintext shown once at creation, never persisted |
| `secret_prefix` | text | NN | identification prefix (same discipline as `api_keys`, 0002) |
| `active` | boolean | NN | `true` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Index: `idx_webhook_endpoints_active(org_id) WHERE active`.

### `webhook_subscriptions`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `endpoint_id` | uuid | NN | composite FK `fk_webhook_subscriptions_endpoint(org_id, endpoint_id) → webhook_endpoints` **ON DELETE CASCADE** |
| `event_type` | text | NN | exact event type or `'*'` wildcard; `ck_webhook_subscriptions_type_nonblank`; **U** `uq_webhook_subscriptions(org_id, endpoint_id, event_type)` (inline) |
| `created_at` | timestamptz | NN | `now()` |

### `webhook_deliveries`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `endpoint_id` | uuid | NN | composite FK `fk_webhook_deliveries_endpoint(org_id, endpoint_id) → webhook_endpoints` |
| `event_id` | uuid | NN | the domain event (logical reference to the event stream / `outbox_events.event_id` — no DDL FK); with `endpoint_id` forms **U** `uq_webhook_deliveries_endpoint_event(org_id, endpoint_id, event_id)` — [idempotent enqueue] replays cannot double-enqueue |
| `event_type` | text | NN | |
| `payload` | jsonb | NN | the delivered envelope |
| `state` | webhook_state | NN | `'queued'` — queued / delivering / delivered / failed / dead_lettered |
| `attempt_count` | integer | NN | `0`; `ck_webhook_deliveries_attempts` (≥ 0) — the bounded retry ladder counter |
| `next_attempt_at` | timestamptz | – | claim scheduling input |
| `delivered_at` | timestamptz | – | `ck_webhook_deliveries_delivered_shape` — delivered ⇔ delivered_at |
| `dead_lettered_at` | timestamptz | – | `ck_webhook_deliveries_dead_shape` — dead_lettered ⇔ dead_lettered_at |
| `last_error` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` — also the claim-lease timestamp for the worker's recovery branch |

- **Terminal states are frozen**: `trg_webhook_deliveries_guard` — delivered/dead_lettered rows
  never change.
- Indexes: `idx_webhook_deliveries_due(org_id, next_attempt_at) WHERE state IN (queued, failed)`
  (per-org scans); plus the worker claim indexes from 0015: `idx_webhook_deliveries_claim_due`
  (expression index on `COALESCE(next_attempt_at, created_at)` — cross-org claim order),
  `idx_webhook_deliveries_claim_lease` (`updated_at WHERE state = 'delivering'` — lease recovery).

## 0013_audit_outbox — tamper-evident audit + transactional outbox

### `audit_events`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | – | NULL for platform-level events (the only nullable org column in the schema); composite chain key with `seq` |
| `actor_type` | text | NN | `ck_audit_actor_type` IN (user, system, api, agent) |
| `actor_id` | text | NN | |
| `action` | text | NN | `ck_audit_action_nonblank` |
| `resource` | text | NN | `ck_audit_resource_nonblank` |
| `resource_id` | text | – | |
| `payload` | jsonb | NN | `'{}'::jsonb`; redaction discipline applied by the writer (`redacted` below) |
| `redacted` | boolean | NN | `false` — marks rows whose payload passed the redaction filter |
| `reason` | text | – | why the consequential action happened |
| `seq` | bigint | NN | `ck_audit_seq` (≥ 1); **U** `uq_audit_events_org_seq(org_id, seq)` — per-org chain sequence; continuity is what makes tampering detectable |
| `prev_hash` | text | NN | `ck_audit_hash_shape` (≥ 32 chars) — hash chain input |
| `hash` | text | NN | hash over (seq, org, actor, action, payload, prev_hash) — computed by the writer, verified by `db/validate.sh` |
| `occurred_at` | timestamptz | NN | `now()` |
| `created_at` | timestamptz | NN | `now()` (NO updated_at — append-only) |

- **[§37] append-only**: `trg_audit_events_guard` rejects UPDATE and DELETE; every consequential
  operation lands here.
- Indexes: `idx_audit_events_resource(org_id, resource, resource_id, occurred_at)`,
  `idx_audit_events_actor(org_id, actor_type, actor_id, occurred_at)`,
  `idx_audit_events_action(org_id, action, occurred_at)`.

### `idempotency_keys`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `scope` | text | NN | `ck_idempotency_scope_nonblank` — command scope namespace |
| `key` | text | NN | `ck_idempotency_key_nonblank`; **U** `uq_idempotency_keys(org_id, scope, key)` (inline) — first-write-wins [R9/C5]; the duplicate insert IS the refusal |
| `outcome_ref` | text | NN | pointer to the original outcome (replayed request returns it) |
| `created_at` | timestamptz | NN | `now()` |

- The durable storage twin of `backend-go/pkg/idempotency`. Index: `uq_idempotency_keys_org_id`.

### `outbox_events`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `event_id` | uuid | NN | **U** `uq_outbox_events_event(org_id, event_id)` (inline) — replaying a command cannot double-append the same event (OUTBOX_DUPLICATE as DDL) |
| `event_type` | text | NN | envelope v1 event type |
| `version` | integer | NN | `1`; `ck_outbox_version` (≥ 1) — envelope schema version |
| `payload` | jsonb | NN | the event envelope |
| `status` | text | NN | `'pending'`; `ck_outbox_status` IN (pending, published, poisoned) — advances pending → published |
| `published_at` | timestamptz | – | stamped when the publisher forwards to the broker |
| `attempts` | integer | NN | `0` — publisher retry counter |
| `last_error` | text | – | |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- Domain transactions append here in the SAME transaction as the state change (transactional
  outbox, F6); the publisher marks them published. Index:
  `idx_outbox_events_pending(org_id, created_at) WHERE status = 'pending'`.

## 0014_crossborder — corridors, FX, transfer intents

### `crossborder_corridors`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `source_currency` | text | NN | closed 6-currency CHECK `ck_corridors_src_ccy`; `ck_corridors_distinct` — source ≠ target |
| `target_currency` | text | NN | closed 6-currency CHECK `ck_corridors_tgt_ccy` |
| `active` | boolean | NN | `true` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- **U** `uq_crossborder_corridors(org_id, source_currency, target_currency)` (inline).
- Index: `idx_crossborder_corridors_active(org_id) WHERE active`.

### `fx_quotes`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `corridor_id` | uuid | NN | composite FK `fk_fx_quotes_corridor(org_id, corridor_id) → crossborder_corridors` |
| `rate_numerator` | bigint | NN | exact rational rate: target = source × (numerator / denominator); `ck_fx_quotes_rate_pos` (> 0) |
| `rate_denominator` | bigint | NN | `ck_fx_quotes_rate_pos` (> 0) |
| `expires_at` | timestamptz | NN | `ck_fx_quotes_expiry` (> quoted_at) — TTL |
| `quoted_at` | timestamptz | NN | `now()` |
| `created_at` | timestamptz | NN | `now()` (NO updated_at — immutable) |

- **[R10] immutable snapshots**: `trg_fx_quotes_guard` refuses UPDATE/DELETE — rate snapshots
  frozen at authorization can never be rewritten; corrections issue a NEW quote. The ONLY
  conversion authority for intents. Index: `idx_fx_quotes_corridor(org_id, corridor_id, quoted_at)`.

### `transfer_intents`

| Column | Type | Null | Default / constraints / notes |
|---|---|---|---|
| `id` | uuid | NN | PK, `gen_random_uuid()` |
| `org_id` | uuid | NN | FK → `orgs(id)` |
| `corridor_id` | uuid | NN | composite FK `fk_transfer_intents_corridor(org_id, corridor_id) → crossborder_corridors` |
| `state` | transfer_intent_state | NN | `'drafted'` — drafted / quoted / authorized / submitted / settled / cancelled |
| `source_amount_minor` | bigint | NN | `ck_transfer_intents_source_pos` (> 0) — stored alongside the settled target amount [R10: no cent created or destroyed] |
| `target_amount_minor` | bigint | – | present ⇔ quote frozen (`ck_transfer_intents_target_shape`) |
| `currency` | text | NN | closed 6-currency CHECK `ck_transfer_intents_ccy` |
| `fee_flat_minor` | bigint | NN | `0`; `ck_transfer_intents_fees` (≥ 0) |
| `fee_bps` | integer | NN | `0`; `ck_transfer_intents_fees` (0…10000) — bps→minor rounding is banker's, applied ONCE at the application layer |
| `quote_id` | uuid | – | logical reference to `fx_quotes(id)` — no DDL FK (the snapshot columns carry the authorization truth); [R10] present exactly from `authorized` onward (`ck_transfer_intents_quote_snapshot`) |
| `quote_numerator` | bigint | – | snapshot copy of the frozen rate |
| `quote_denominator` | bigint | – | snapshot copy of the frozen rate |
| `quote_expires_at` | timestamptz | – | snapshot of the quote TTL |
| `source_ref` | text | – | external submit reference; `ck_transfer_intents_source_ref_nonblank` when present; **U** `uq_transfer_intents_source_ref(org_id, source_ref)` — idempotent submit replay |
| `submitted_at` | timestamptz | – | |
| `settled_at` | timestamptz | – | `ck_transfer_intents_settled_shape` — settled ⇔ settled_at |
| `cancelled_at` | timestamptz | – | `ck_transfer_intents_cancelled_shape` — cancelled ⇔ cancelled_at |
| `sequence_no` | bigint | NN | `ck_transfer_intents_seq` (≥ 1); **U** `uq_transfer_intents_seq(org_id, sequence_no)` |
| `created_at` | timestamptz | NN | `now()` |
| `updated_at` | timestamptz | NN | `now()` |

- This lane writes **NO fund truth** — settlement postings stay in the ledger (0008).
- Indexes: `idx_transfer_intents_state`, `idx_transfer_intents_corridor(org_id, corridor_id, created_at)`.

## 0015_read_model_indexes — additive indexes (no table/column changes)

Purely additive: ten indexes over the mounted `/v1` read models, each derived from a statement the
Go kernel runs and EXPLAIN-evidenced (`db/explain/0015-{before,after}.txt`; map in `db/README.md`):

| Index | Table | Definition | Serves |
|---|---|---|---|
| `idx_receivables_org_created` | receivables | (org_id, created_at, id) | GET /v1/receivables default page + org count |
| `idx_receivables_org_due` | receivables | (org_id, due_date, id) | GET /v1/receivables?sort=dueDate |
| `idx_payments_org_created` | payments | (org_id, created_at, id) | GET /v1/payments default page + org count |
| `idx_payments_org_initiated` | payments | (org_id, initiated_at, id) | GET /v1/payments?sort=initiatedAt (subsumes idx_payments_initiated_at) |
| `idx_collections_cases_org_created` | collections_cases | (org_id, created_at, id) | GET /v1/collections/cases default page |
| `idx_allocations_payment_live` | allocations | (org_id, source_type, source_id, allocated_at, id) WHERE reversed_at IS NULL | payment detail allocations + R6 ceiling input |
| `idx_promises_receivable_open` | promises | (org_id, receivable_id) WHERE state IN (created, pending, partially_fulfilled) | case-detail pending-promise overlay |
| `idx_role_assignments_revoked_grant` | role_assignments | (revoked_grant_id) WHERE revoked_grant_id IS NOT NULL | auth anti-join hot path (every request) |
| `idx_webhook_deliveries_claim_due` | webhook_deliveries | (COALESCE(next_attempt_at, created_at), created_at, id) WHERE state IN (queued, failed) | worker ClaimDue due branch (cross-org) |
| `idx_webhook_deliveries_claim_lease` | webhook_deliveries | (updated_at) WHERE state = 'delivering' | worker ClaimDue lease recovery |

## ERD — ops/platform tables

`docs/design/diagrams/d15_er_ops.png` (source: `d15_er_ops.mmd`) covers the wave 10–11 ops
surface: communications (0011), webhooks (0012), audit/outbox/idempotency (0013) and crossborder
(0014). Every edge shown is a composite `(org_id, parent_id)` FK; logical references without a DDL
FK are labelled as such.

## Posting matrix (sub-ledger, K5/R4)

The whitelist `posting_matrix` seeds (account-KIND pairs per posting source). The COMMIT proof
(`trg_ledger_entries_check_r4`) refuses unmapped postings:

| Operation | Debit | Credit |
|-----------|-------|--------|
| Invoice issued | AR control (asset) | Revenue (income) |
| Payment confirmed | M-Pesa float (asset) | AR control (asset) |
| Allocation executed | — (memo only; movement is within AR) | — |
| Refund completed | Refund clearing / expense | M-Pesa float (asset) |
| Credit balance applied | Credit balance liability | AR control (asset) |
| Late fee accrued (wave 2) | AR control (asset) | Fee income (income) |
| Write-off | Bad debt expense (expense) | AR control (asset) |

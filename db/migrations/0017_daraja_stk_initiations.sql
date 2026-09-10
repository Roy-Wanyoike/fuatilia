-- 0017_daraja_stk_initiations.sql — the Daraja outbound wiring surface
-- (issue #178): the merchant-side records the callback endpoints route on.
--
-- Two tables, two jobs:
--
--   * stk_initiations — the merchant's OWN initiation record (E11). The
--     execute path writes it when the rail accepts a push; the STK result
--     callback resolves (org, requested amount, customer) from it. Daraja's
--     CheckoutRequestID is the rail-minted global identity, so THIS ONE
--     lookup is intentionally global (unique on the column alone) — every
--     other query stays org-scoped. Failure results carry NO amount on the
--     wire; this row is what the intake amount backs (the parser refuses
--     DARAJA_STK_AMOUNT_UNKNOWN without it).
--
--   * daraja_callback_journeys — the DURABLE JourneyLedger behind the R9
--     intake funnel (internal/daraja/intake.go ClaimJourney). One row per
--     processed money-journey ('stk:<checkoutRequestId>' /
--     'c2b:<TransID>'); the PRIMARY KEY is the atomic claim: INSERT ON
--     CONFLICT DO NOTHING semantics make concurrent at-least-once
--     redeliveries produce exactly one winner, and the stored amount is the
--     tamper tripwire (same journey, different money → refused).
--
-- Invariants encoded here:
--   * [R10] STK collects on the M-Pesa rail: KES only, requested_minor > 0.
--   * [R9] one checkout per rail mint (global unique); one initiation per
--     (org, idempotency key) — the retry-safe key 'stkpush:<actionId>'.
--   * [R3-append-mostly] an initiation only evolves initiated →
--     reconciled|failed exactly once (state shape CHECK + resolved_at).

CREATE TABLE stk_initiations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL REFERENCES orgs(id),
    -- The collections execution action this push serves (opaque ref; the
    -- collections lane's action id — never a cross-tenant FK).
    action_id           text NOT NULL,
    -- Daraja-minted identity of the live push. GLOBALLY unique: the result
    -- callback carries nothing but this id, so it is the org router.
    checkout_request_id text NOT NULL,
    merchant_request_id text NOT NULL,
    customer_id         uuid,          -- NULL = unattributed payer (unapplied parking)
    -- The R9 initiation key ('stkpush:<actionId>') — retry-safe execution.
    idempotency_key     text NOT NULL,
    -- What the merchant asked for (E11) — the intake amount on EVERY result.
    requested_minor     bigint NOT NULL,
    currency            text NOT NULL CONSTRAINT ck_stk_init_currency CHECK (currency = 'KES'),
    state               text NOT NULL DEFAULT 'initiated'
                        CONSTRAINT ck_stk_init_state CHECK (state IN ('initiated', 'reconciled', 'failed')),
    initiated_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_late       boolean,
    failure_code        text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ck_stk_init_checkout_nonblank CHECK (char_length(btrim(checkout_request_id)) >= 1),
    CONSTRAINT ck_stk_init_merchant_nonblank CHECK (char_length(btrim(merchant_request_id)) >= 1),
    CONSTRAINT ck_stk_init_action_nonblank   CHECK (char_length(btrim(action_id)) >= 1),
    CONSTRAINT ck_stk_init_idem_nonblank     CHECK (char_length(btrim(idempotency_key)) >= 1),
    CONSTRAINT ck_stk_init_requested_pos     CHECK (requested_minor > 0),
    -- The state shape: only a RESOLVED initiation carries when/why.
    CONSTRAINT ck_stk_init_resolved_shape CHECK (
        (state IN ('reconciled', 'failed')) = (resolved_at IS NOT NULL)),
    CONSTRAINT ck_stk_init_failure_shape CHECK (
        (state = 'failed') = (failure_code IS NOT NULL))
);

-- [R9] the rail-minted checkout id is THE callback org router.
CREATE UNIQUE INDEX uq_stk_initiations_checkout ON stk_initiations (checkout_request_id);
-- [R9] retry-safe execution: one initiation per (org, initiation key).
CREATE UNIQUE INDEX uq_stk_initiations_org_idem ON stk_initiations (org_id, idempotency_key);
CREATE UNIQUE INDEX uq_stk_initiations_org_id   ON stk_initiations (org_id, id);
-- Ops: stuck-push sweeps scan by state (the runbook's reconciliation queue).
CREATE INDEX idx_stk_initiations_org_state ON stk_initiations (org_id, state, initiated_at);

ALTER TABLE stk_initiations
    ADD CONSTRAINT fk_stk_init_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE TRIGGER trg_stk_initiations_touch BEFORE UPDATE ON stk_initiations
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE  stk_initiations IS '[E11] the merchant record an STK result callback reconciles against — org router by the globally-unique rail-minted checkout id (issue #178).';
COMMENT ON INDEX  uq_stk_initiations_checkout IS '[R9] one rail mint = one initiation; the callback resolves (org, amount, customer) from this row.';
COMMENT ON INDEX  uq_stk_initiations_org_idem IS '[R9] the stkpush:<actionId> initiation key is unique per org — retries replay, never re-prompt.';

-- ---------------------------------------------------------------------------
-- daraja_callback_journeys — the durable JourneyLedger behind
-- daraja.IntakeCallback (R9 at-least-once intake funnel, issue #178).
-- ---------------------------------------------------------------------------

CREATE TABLE daraja_callback_journeys (
    journey_key  text PRIMARY KEY,   -- 'stk:<checkoutRequestId>' / 'c2b:<TransID>'
    org_id       uuid NOT NULL REFERENCES orgs(id),
    kind         text NOT NULL CONSTRAINT ck_daraja_journey_kind CHECK (kind IN ('c2b-confirmation', 'stk-result')),
    -- The money the journey was FIRST claimed with — the K1 tamper tripwire
    -- compares every redelivery against it exactly.
    amount_minor bigint NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_daraja_journey_amount_pos CHECK (amount_minor > 0)
);

COMMENT ON TABLE daraja_callback_journeys IS '[R9] the at-least-once intake funnel''s durable claim ledger: PRIMARY KEY = the atomic claim; amount_minor = the tamper tripwire (issue #178).';

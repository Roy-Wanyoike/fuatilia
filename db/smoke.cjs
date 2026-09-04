#!/usr/bin/env node
'use strict';
/**
 * db/smoke.cjs — invariant proof harness (issue #66).
 *
 * Runs against a MIGRATED database and proves the financial invariants
 * actually FIRE — each case either succeeds or expects a specific failure
 * (error code or message fragment). Every case runs in its own transaction
 * (one Query message), so a failed case leaves no trace for later cases.
 *
 * Cases (issue #66 acceptance list):
 *   a) ledger append-only: UPDATE and DELETE refused (R3)
 *   b) unbalanced ledger entry refused at COMMIT (R4)
 *   c) unmapped posting refused (R5/K5); a whitelisted posting succeeds
 *   d) idempotency_keys replay refused (R9/C5)
 *   e) R8: a second OPEN case for the same receivable refused
 *   f) role_assignments append-only (grants/revokes are facts)
 *   g) audit trail append-only (SPEC §37)
 *   h) fx_quotes immutable snapshots (R10)
 *   i) webhook terminal states frozen
 *   j) R2: allocation beyond confirmed funds refused at COMMIT
 *
 * Exit 0 = every case proved; exit 1 = any failure. --ci runs the same suite.
 */

const { connect, PgError } = require('./pgclient.cjs');

let passed = 0;
let failed = 0;

function fail(name, detail) {
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function pass(name, detail) {
  passed++;
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
}

function describes(err, needle) {
  if (err instanceof PgError) {
    return `${err.code} ${err.message}`.includes(needle);
  }
  return String(err && err.message).includes(needle);
}

async function main() {
  const conn = await connect({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 55432),
    user: process.env.PGUSER || 'fuatilia',
    database: process.env.PGDATABASE || 'fuatilia_validate',
  });

  // Every case = one Query message = one transaction.
  const tx = (sql) => conn.query(sql);
  // Expect success; any error fails the case.
  async function ok(name, sql) {
    try {
      await tx(sql);
      pass(name);
      return true;
    } catch (e) {
      fail(name, e instanceof PgError ? `${e.code} ${e.message}` : e.message);
      return false;
    }
  }
  // Expect a failure whose code+message contains `needle`.
  async function rejects(name, sql, needle) {
    try {
      await tx(sql);
      fail(name, `expected an error containing "${needle}" but the statement SUCCEEDED`);
      return false;
    } catch (e) {
      if (describes(e, needle)) {
        pass(name, e instanceof PgError ? e.code : '');
        return true;
      }
      fail(name, `expected "${needle}", got: ${e instanceof PgError ? `${e.code} ${e.message}` : e.message}`);
      return false;
    }
  }

  console.log('smoke: seeding org + accounts');
  await ok('seed org', `INSERT INTO orgs (id, name, slug) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Smoke Co', 'smoke-co')`);

  await ok('seed ledger accounts (asset cash + income)', `
    INSERT INTO ledger_accounts (id, org_id, code, name, kind, currency) VALUES
      ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', '1000', 'Mobile Money Clearing', 'asset',   'KES'),
      ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '4000', 'Collection Income',     'income', 'KES')`);

  // (c) unmapped posting → POSTING_NOT_MAPPED; the entry is ROLLBACK BACK as a
  // whole by the deferrable trigger, so the matrix row must be added FIRST in
  // the success case.
  await rejects('c1 unmapped posting refused at COMMIT (R5/K5)', `
    INSERT INTO ledger_entries (org_id, entry_id, line_no, account_id, direction, amount_minor, currency, source, journal_ref) VALUES
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333301', 1,
       '22222222-2222-2222-2222-222222222221', 'debit',  5000, 'KES', 'payment_confirmed', 'J-1'),
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333301', 2,
       '22222222-2222-2222-2222-222222222222', 'credit', 5000, 'KES', 'payment_confirmed', 'J-1');
`,
    'POSTING_NOT_MAPPED');

  await ok('c2 whitelisted posting commits (R5/K5)', `
    INSERT INTO posting_matrix (org_id, source, debit_kind, credit_kind) VALUES
      ('11111111-1111-1111-1111-111111111111', 'payment_confirmed', 'asset', 'income');
    INSERT INTO ledger_entries (org_id, entry_id, line_no, account_id, direction, amount_minor, currency, source, journal_ref) VALUES
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333302', 1,
       '22222222-2222-2222-2222-222222222221', 'debit',  5000, 'KES', 'payment_confirmed', 'J-2'),
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333302', 2,
       '22222222-2222-2222-2222-222222222222', 'credit', 5000, 'KES', 'payment_confirmed', 'J-2');
`);

  // (b) unbalanced entry refused at COMMIT (R4).
  await rejects('b1 unbalanced ledger entry refused (R4)', `
    INSERT INTO ledger_entries (org_id, entry_id, line_no, account_id, direction, amount_minor, currency, source, journal_ref) VALUES
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333303', 1,
       '22222222-2222-2222-2222-222222222221', 'debit',  5000, 'KES', 'payment_confirmed', 'J-3'),
      ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333303', 2,
       '22222222-2222-2222-2222-222222222222', 'credit', 4999, 'KES', 'payment_confirmed', 'J-3');
`,
    'LEDGER_UNBALANCED');

  // (a) ledger append-only (R3).
  await rejects('a1 ledger UPDATE refused (R3)', `
    UPDATE ledger_entries SET amount_minor = 1
     WHERE org_id = '11111111-1111-1111-1111-111111111111'
       AND journal_ref = 'J-2';`,
    'LEDGER_APPEND_ONLY');
  await rejects('a2 ledger DELETE refused (R3)', `
    DELETE FROM ledger_entries
     WHERE org_id = '11111111-1111-1111-1111-111111111111'
       AND journal_ref = 'J-2';`,
    'LEDGER_APPEND_ONLY');

  // (d) idempotency replay refused (R9/C5).
  await ok('d1 idempotency first write wins', `
    INSERT INTO idempotency_keys (org_id, scope, key, outcome_ref) VALUES
      ('11111111-1111-1111-1111-111111111111', 'payments', 'dup-1', 'payment:abc')`);
  await rejects('d2 idempotency replay refused (R9/C5)', `
    INSERT INTO idempotency_keys (org_id, scope, key, outcome_ref) VALUES
      ('11111111-1111-1111-1111-111111111111', 'payments', 'dup-1', 'payment:other')`,
    'uq_idempotency_keys');

  // (f) role_assignments append-only (grant facts are never edited).
  await ok('f0 seed users + role + grant fact', `
    INSERT INTO users (id, org_id, email, username, display_name, password_hash) VALUES
      ('88888888-8888-8888-8888-888888888801', '11111111-1111-1111-1111-111111111111', 'owner@smoke.example', 'smokeowner', 'Smoke Owner', 'scrypt:smoke'),
      ('88888888-8888-8888-8888-888888888803', '11111111-1111-1111-1111-111111111111', 'admin@smoke.example', 'smokeadmin', 'Smoke Admin', 'scrypt:smoke');
    INSERT INTO roles (id, org_id, name, permissions) VALUES
      ('88888888-8888-8888-8888-888888888802', '11111111-1111-1111-1111-111111111111', 'Collector', ARRAY['collections:read']);
    INSERT INTO role_assignments (org_id, kind, user_id, role_id, granted_by) VALUES
      ('11111111-1111-1111-1111-111111111111', 'grant',
       '88888888-8888-8888-8888-888888888801', '88888888-8888-8888-8888-888888888802',
       '88888888-8888-8888-8888-888888888803')`);
  await rejects('f1 role_assignments UPDATE refused', `
    UPDATE role_assignments SET granted_at = now()
     WHERE org_id = '11111111-1111-1111-1111-111111111111';`,
    'ROLE_ASSIGNMENTS_APPEND_ONLY');

  // (g) audit trail append-only (SPEC §37).
  await ok('g1 audit append works', `
    INSERT INTO audit_events (org_id, actor_type, actor_id, action, resource, resource_id, seq, prev_hash, hash) VALUES
      ('11111111-1111-1111-1111-111111111111', 'system', 'smoke', 'smoke.seed', 'org', '11111111-1111-1111-1111-111111111111',
       1, repeat('a', 64), repeat('b', 64))`);
  await rejects('g2 audit UPDATE refused (§37)', `
    UPDATE audit_events SET payload = '{}'::jsonb
     WHERE org_id = '11111111-1111-1111-1111-111111111111';`,
    'AUDIT_APPEND_ONLY');
  await rejects('g3 audit DELETE refused (§37)', `
    DELETE FROM audit_events
     WHERE org_id = '11111111-1111-1111-1111-111111111111';`,
    'AUDIT_APPEND_ONLY');

  // (h) fx_quotes immutable (R10).
  await ok('h1 seed corridor + quote', `
    INSERT INTO crossborder_corridors (id, org_id, source_currency, target_currency) VALUES
      ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'KES', 'USD');
    INSERT INTO fx_quotes (org_id, corridor_id, rate_numerator, rate_denominator, expires_at) VALUES
      ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444401', 1, 130, now() + interval '5 minutes')`);
  await rejects('h2 fx_quotes UPDATE refused (R10)', `
    UPDATE fx_quotes SET rate_numerator = 2
     WHERE org_id = '11111111-1111-1111-1111-111111111111';`,
    'FX_QUOTES_IMMUTABLE');

  // (i) webhook terminal states frozen.
  await ok('i1 seed endpoint + delivery', `
    INSERT INTO webhook_endpoints (org_id, url, secret_hash, secret_prefix) VALUES
      ('11111111-1111-1111-1111-111111111111', 'https://hooks.example.com/fuatilia', 'sha256:smoke', 'whsec_smoke');
    INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload) VALUES
      ('11111111-1111-1111-1111-111111111111',
       (SELECT id FROM webhook_endpoints WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       gen_random_uuid(), 'payment.received', '{"smoke": true}')`);
  await rejects('i2 delivered delivery is frozen', `
    UPDATE webhook_deliveries SET state = 'delivered', delivered_at = now()
     WHERE org_id = '11111111-1111-1111-1111-111111111111';
    UPDATE webhook_deliveries SET state = 'failed'
     WHERE org_id = '11111111-1111-1111-1111-111111111111';`,
    'WEBHOOK_DELIVERY_TERMINAL');

  // (e) R8 one-open-case-per-receivable + (j) R2 allocation ceiling.
  console.log('smoke: seeding customer + invoice + receivable + payment');
  await ok('e1 seed customer/invoice/receivable/payment', `
    INSERT INTO customers (id, org_id, display_name, email) VALUES
      ('55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 'ABC Hardware', 'abc@example.com');
    INSERT INTO invoices (org_id, customer_id, status, currency, total_minor, invoice_number, issued_at, due_date) VALUES
      ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555501', 'issued', 'KES', 420000, 'INV-0001', now(), now() + interval '30 days');
    INSERT INTO receivables (id, org_id, invoice_id, customer_id, currency, original_minor, state, due_date) VALUES
      ('66666666-6666-6666-6666-666666666601', '11111111-1111-1111-1111-111111111111',
       (SELECT id FROM invoices WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       '55555555-5555-5555-5555-555555555501', 'KES', 420000, 'open', now() + interval '30 days');
    INSERT INTO payments (org_id, channel, external_ref, idempotency_key, state, currency, requested_minor, confirmed_minor, confirmed_at) VALUES
      ('11111111-1111-1111-1111-111111111111', 'c2b', 'SBK41XQ7RT', 'idem-1', 'confirmed', 'KES', 10000, 10000, now())`);

  await ok('e2 first open case accepted (R8)', `
    INSERT INTO collections_cases (id, org_id, case_number, owner_id, sequence_no) VALUES
      ('77777777-7777-7777-7777-777777777701', '11111111-1111-1111-1111-111111111111', 'CASE-0001', '88888888-8888-8888-8888-888888888801', 1);
    INSERT INTO collections_case_receivables (org_id, case_id, receivable_id) VALUES
      ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777701',
       '66666666-6666-6666-6666-666666666601')`);
  await rejects('e3 second OPEN case for the same receivable refused (R8)', `
    INSERT INTO collections_cases (id, org_id, case_number, owner_id, sequence_no) VALUES
      ('77777777-7777-7777-7777-777777777702', '11111111-1111-1111-1111-111111111111', 'CASE-0002', '88888888-8888-8888-8888-888888888801', 2);
    INSERT INTO collections_case_receivables (org_id, case_id, receivable_id) VALUES
      ('11111111-1111-1111-1111-111111111111', '77777777-7777-7777-7777-777777777702',
       '66666666-6666-6666-6666-666666666601');
`,
    'uq_r8_one_open_case_per_receivable');
  await rejects('e4 case identity is frozen after creation', `
    UPDATE collections_cases SET case_number = 'CASE-HACK'
     WHERE org_id = '11111111-1111-1111-1111-111111111111' AND case_number = 'CASE-0001';`,
    'CASE_IDENTITY_FROZEN');

  await rejects('j1 allocation beyond confirmed funds refused at COMMIT (R2)', `
    INSERT INTO allocations (org_id, source_type, source_payment_id, source_id, receivable_id, amount_minor, currency, sequence_no) VALUES
      ('11111111-1111-1111-1111-111111111111', 'payment',
       (SELECT id FROM payments WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       (SELECT id FROM payments WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       '66666666-6666-6666-6666-666666666601', 99999, 'KES', 1);
`,
    'ALLOCATION_EXCEEDS_CONFIRMED');

  await ok('j2 allocation within confirmed funds commits and updates applied_minor (R1/R2)', `
    INSERT INTO allocations (org_id, source_type, source_payment_id, source_id, receivable_id, amount_minor, currency, sequence_no) VALUES
      ('11111111-1111-1111-1111-111111111111', 'payment',
       (SELECT id FROM payments WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       (SELECT id FROM payments WHERE org_id = '11111111-1111-1111-1111-111111111111' LIMIT 1),
       '66666666-6666-6666-6666-666666666601', 10000, 'KES', 1)`);
  await ok('j3 receivable applied_minor equals Σ(active allocations) (R1)', `
    DO $$
    DECLARE v_applied bigint; v_stored bigint;
    BEGIN
      SELECT applied_minor INTO v_stored FROM receivables
       WHERE org_id = '11111111-1111-1111-1111-111111111111'
         AND id = '66666666-6666-6666-6666-666666666601';
      SELECT COALESCE(SUM(amount_minor), 0) INTO v_applied FROM allocations
       WHERE org_id = '11111111-1111-1111-1111-111111111111'
         AND receivable_id = '66666666-6666-6666-6666-666666666601'
         AND reversed_at IS NULL AND reversal_of IS NULL;
      IF v_applied <> v_stored THEN
        RAISE EXCEPTION 'R1_DRIFT: applied % <> sum %', v_stored, v_applied;
      END IF;
    END $$;`);

  await conn.end();
  console.log(`smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke: FATAL ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
/**
 * perf/seed/seed_perf.cjs — deterministic PG fixture for the k6 load harness
 * (issue #147). Modeled on db/seed_explain.cjs (issue #137): stdlib only,
 * talks PostgreSQL through db/pgclient.cjs (trust auth, simple-query
 * protocol), seeded PRNG so re-running on a fresh database reproduces the
 * exact fixture.
 *
 * WHAT IT SEEDS (one tenant org, harness-sized by default):
 *   orgs, users, a role + grants, THE HARNESS API KEY, customers,
 *   invoices + receivables (realistic state mix), payments (realistic state
 *   mix), collections cases + receivable links (R8-safe) + case actions,
 *   the ledger chart + balanced journal lines (R3/R4-safe: every entry's
 *   Σdebit == Σcredit in KES — the DEFERRABLE trigger proves it at COMMIT)
 *   and the adjustments feed's backing rows (R6-safe refunds on confirmed
 *   payments + credit notes).
 *
 * THE HARNESS API KEY is the load test's credential:
 *   key id  = fixed uuid (printed below)
 *   secret  = "perf-fixture-only-0000" (FIXTURE-ONLY, stored as SHA-256 hex —
 *             exactly what backend-go/internal/auth.SHA256Codec verifies).
 *   scopes  = receivables:read, payments:read, payments:intake,
 *             payments:refund, collections:read, collections:act,
 *             ledger:read, adjustments:request
 * It authenticates nothing outside a local trust-auth database. NEVER seed
 * it into a shared/production cluster; never reuse the secret elsewhere.
 *
 * Usage (env-driven; defaults target the boot_pg lane cluster):
 *   PGDATABASE=fuatilia_perf node perf/seed/seed_perf.cjs
 *   PGHOST/PGPORT/PGUSER override the 127.0.0.1:5435/postgres defaults;
 *   PERF_SEED_SCALE=N multiplies every row count (default 1).
 * The database must already have db/migrations 0001–0015 applied
 * (PGDATABASE=fuatilia_perf node db/migrate.cjs).
 *
 * Idempotent: TRUNCATE orgs CASCADE wipes every org-owned table first
 * (schema_migrations survives — it is FK-independent).
 */

const crypto = require('crypto');
const path = require('path');
const { connect, PgError } = require(path.join(__dirname, '..', '..', 'db', 'pgclient.cjs'));

// --- deterministic PRNG (mulberry32) + derived helpers -----------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(147147);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// Sequential uuid-v4-shaped ids (stable across runs, unique within the DB).
// The b147 prefix namespace is DISTINCT from db/seed_explain.cjs (a137…).
let uuidCounter = 0;
const UUID_BASE = 'b1470000-0000-4000-8000-';
function uuid() {
  const n = (++uuidCounter).toString(16).padStart(12, '0');
  return UUID_BASE + n;
}

// Fixed base instant; everything spreads backwards from it.
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const ts = (daysAgo) => new Date(BASE_MS - Math.floor(daysAgo * DAY) - ri(0, DAY - 1)).toISOString();

// --- SQL literal helpers (same conventions as db/seed_explain.cjs) -----------
const S = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const N = (n) => (n === null || n === undefined ? 'NULL' : String(Math.round(n)));
const ARR = (a) => (a === null ? 'NULL' : `'{${a.join(',')}}'`); // text[] input syntax

async function insertBatched(conn, table, columns, rows) {
  const BATCH = 400;
  let done = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const chunk = rows.slice(off, off + BATCH);
    const tuples = chunk.map((row) => `(${row.join(', ')})`).join(',\n');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${tuples}`;
    try {
      await conn.query(sql);
    } catch (e) {
      if (e instanceof PgError) {
        throw new Error(`seed: ${table} batch at offset ${off} failed: ${e.code} ${e.message}`);
      }
      throw e;
    }
    done += chunk.length;
  }
  return done;
}

// --- fixture shape (scale knob keeps the default seed fast but >100 pages) ---
const SCALE = Math.max(1, Number(process.env.PERF_SEED_SCALE || '1') || 1);
const COUNTS = {
  customers: 400 * SCALE,
  receivables: 6000 * SCALE,
  payments: 8000 * SCALE,
  cases: 900 * SCALE,
  ledgerEntries: 10000 * SCALE, // balanced double-entries × 2 lines each
  refunds: 400 * SCALE,
  creditNotes: 400 * SCALE,
};

// The harness credential (fixture-only — see the header). Secret ≥16 chars.
const HARNESS_SECRET = 'perf-fixture-only-0000';
const HARNESS_KEY_ID = 'b147aaaa-0000-4000-8000-000000000001';
const HARNESS_SCOPES = [
  'receivables:read',
  'payments:read',
  'payments:intake',
  'payments:refund',
  'collections:read',
  'collections:act',
  'ledger:read',
  'adjustments:request',
];

const ORG = { id: uuid(), slug: 'perf-main', name: 'Perf Fixture Main (issue #147)' };

async function main() {
  const opts = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5435),
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE,
  };
  if (!opts.database) {
    console.error('seed: PGDATABASE is required (e.g. fuatilia_perf)');
    process.exit(2);
  }
  const conn = await connect(opts).catch((e) => {
    console.error(`seed: CONNECT-FAILED ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${e.message}`);
    process.exit(2);
  });

  try {
    const q = (s) => conn.query(s);
    const t0 = Date.now();
    const step = (name, n) =>
      console.log(`seed: ${name.padEnd(30)} ${String(n).padStart(7)} rows  ${String((Date.now() - t0) / 1000 | 0).padStart(4)}s`);

    // 0) clean slate (orgs is the tenant root — CASCADE reaches every table).
    await q('TRUNCATE orgs CASCADE');

    await insertBatched(conn, 'orgs', ['id', 'name', 'slug', 'status', 'created_at'],
      [[S(ORG.id), S(ORG.name), S(ORG.slug), S('active'), S(ts(600))]]);
    step('orgs', 1);

    // 1) auth lane: three users (owner active), one role, cross-grants
    //    (ck_role_assignments_no_self_grant forbids self-granting).
    const users = [
      { id: uuid(), email: 'perf-owner@perf-main.test', username: 'perf_owner', name: 'Perf Owner', status: 'active' },
      { id: uuid(), email: 'perf-collector@perf-main.test', username: 'perf_collector', name: 'Perf Collector', status: 'active' },
      { id: uuid(), email: 'perf-finance@perf-main.test', username: 'perf_finance', name: 'Perf Finance', status: 'active' },
    ];
    const roleId = uuid();
    await insertBatched(conn, 'users',
      ['id', 'org_id', 'email', 'username', 'display_name', 'status', 'password_hash', 'created_at'],
      users.map((u, i) => [S(u.id), S(ORG.id), S(u.email), S(u.username), S(u.name), S(u.status),
        // password_hash is opaque verifier bytes; the sessions lane never
        // reads it for api-key auth. Fixture digest only — NOT a credential.
        S(`v1-fixture-digest-${crypto.randomBytes(16).toString('hex')}`), S(ts(560 - i))]));
    step('users', users.length);

    await insertBatched(conn, 'roles', ['id', 'org_id', 'name', 'permissions', 'created_at'],
      [[S(roleId), S(ORG.id), S('perf-admin'), ARR(HARNESS_SCOPES), S(ts(560))]]);

    // Cross-grants: each user granted by another (the no-self-grant CHECK).
    await insertBatched(conn, 'role_assignments',
      ['id', 'org_id', 'kind', 'user_id', 'role_id', 'resource_id', 'granted_by', 'granted_at'],
      users.map((u, i) => [S(uuid()), S(ORG.id), S('grant'), S(u.id), S(roleId), 'NULL',
        S(users[(i + 1) % users.length].id), S(ts(550))]));
    step('roles + grants', 1 + users.length);

    // THE harness api key. secret_hash = lowercase hex SHA-256 of the secret
    // (backend-go/internal/auth.SHA256Codec). prefix = first 8 visible chars.
    const secretHash = crypto.createHash('sha256').update(HARNESS_SECRET, 'utf8').digest('hex');
    await insertBatched(conn, 'api_keys',
      ['key_id', 'org_id', 'name', 'created_by', 'prefix', 'secret_hash', 'scopes', 'expires_at', 'status', 'created_at'],
      [[S(HARNESS_KEY_ID), S(ORG.id), S('k6-harness'), S(users[0].id), S(HARNESS_SECRET.slice(0, 8)),
        S(secretHash), ARR(HARNESS_SCOPES), 'NULL', S('active'), S(ts(30))]]);
    step('api_keys (harness)', 1);

    // 2) customers (FK targets for receivables/payments).
    const customers = [];
    for (let i = 0; i < COUNTS.customers; i++) {
      customers.push({
        id: uuid(), name: `Perf Customer ${i + 1} Ltd`,
        msisdn: `2547${String(10000000 + i).slice(0, 8)}`,
      });
    }
    await insertBatched(conn, 'customers',
      ['id', 'org_id', 'display_name', 'msisdn', 'email', 'segment', 'status', 'created_at'],
      customers.map((c) => [S(c.id), S(ORG.id), S(c.name), S(c.msisdn), S(`c${c.msisdn}@fixture.test`),
        S(pick(['vip', 'standard', 'standard', 'risky'])), S('active'), S(ts(ri(200, 590)))]));
    step('customers', customers.length);

    // 3) invoices + receivables. Same state mix discipline as the explain
    //    fixture: settled ⇒ applied = original (balance 0), voided ⇒ applied 0,
    //    written_off/uncollectible carry their reason columns.
    const statePlan = [
      ['open', 0.34], ['partially_paid', 0.24], ['settled', 0.24],
      ['written_off', 0.04], ['uncollectible', 0.04], ['voided', 0.03], ['draft', 0.07],
    ];
    const weighted = [];
    statePlan.forEach(([s, p]) => { for (let i = 0; i < p * 100; i++) weighted.push(s); });
    const receivables = [];
    const invoices = [];
    for (let i = 0; i < COUNTS.receivables; i++) {
      const createdDaysAgo = ri(0, 540);
      const state = weighted[Math.floor(rand() * weighted.length)];
      const invoice = {
        id: uuid(), customer: customers[i % customers.length].id,
        total: ri(50, 50000) * 100, number: `INV-PERF-${i + 1}`,
      };
      invoices.push(invoice);
      const applied = state === 'settled' ? invoice.total : (state === 'partially_paid' ? Math.floor(invoice.total / 2) : 0);
      receivables.push({
        id: uuid(), invoice: invoice.id, customer: invoice.customer,
        original: invoice.total, applied, state,
        overdue: (state === 'open' || state === 'partially_paid') && rand() < 0.45,
        dueDate: new Date(BASE_MS - Math.floor((createdDaysAgo - 30) * DAY)).toISOString(),
        createdAt: new Date(BASE_MS - Math.floor(createdDaysAgo * DAY)).toISOString(),
        writeOffReason: state === 'written_off' ? 'insolvent debtor (perf fixture)' : null,
        uncollectibleReason: state === 'uncollectible' ? 'statute-barred (perf fixture)' : null,
      });
    }
    await insertBatched(conn, 'invoices',
      ['id', 'org_id', 'customer_id', 'status', 'currency', 'total_minor', 'invoice_number', 'issued_at', 'due_date', 'created_at'],
      invoices.map((v) => [S(v.id), S(ORG.id), S(v.customer), S('issued'), S('KES'), N(v.total), S(v.number),
        S(ts(540)), S(ts(500)), S(ts(540))]));
    await insertBatched(conn, 'receivables',
      ['id', 'org_id', 'invoice_id', 'customer_id', 'currency', 'original_minor', 'applied_minor',
        'state', 'overdue', 'opened_at', 'due_date', 'write_off_reason', 'write_off_approved_by',
        'uncollectible_reason', 'created_at'],
      receivables.map((r) => [S(r.id), S(ORG.id), S(r.invoice), S(r.customer), S('KES'), N(r.original), N(r.applied),
        S(r.state), S(r.overdue), S(r.createdAt), S(r.dueDate), S(r.writeOffReason),
        S(r.writeOffReason ? 'perf-fixture-admin' : null), S(r.uncollectibleReason), S(r.createdAt)]));
    step('invoices + receivables', invoices.length + receivables.length);

    // 4) payments (fund truth) with a realistic state mix. Confirmed family
    //    carries confirmed_minor (ck_payments_state_confirmed_shape).
    const payStatePlan = [
      ['initiated', 0.10], ['pending_confirmation', 0.04], ['confirmed', 0.28],
      ['partially_allocated', 0.18], ['allocated', 0.18], ['unapplied', 0.10],
      ['failed', 0.06], ['reversed', 0.02], ['partially_refunded', 0.02], ['refunded', 0.02],
    ];
    const payWeighted = [];
    payStatePlan.forEach(([s, p]) => { for (let i = 0; i < p * 100; i++) payWeighted.push(s); });
    const CONFIRMED_FAMILY = new Set(['confirmed', 'partially_allocated', 'allocated', 'unapplied', 'partially_refunded', 'refunded', 'reversed']);
    const payments = [];
    for (let i = 0; i < COUNTS.payments; i++) {
      const state = payWeighted[Math.floor(rand() * payWeighted.length)];
      const confirmed = CONFIRMED_FAMILY.has(state);
      const amount = ri(100, 20000) * 100;
      const initiatedDaysAgo = ri(0, 540);
      const initiatedAt = new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY)).toISOString();
      payments.push({
        id: uuid(),
        customer: rand() < 0.8 ? customers[i % customers.length].id : null,
        channel: rand() < 0.7 ? 'c2b' : 'stk',
        externalRef: `perf-fixture-TX${i + 1}`,
        idemKey: `perf-fixture-idem-${i + 1}`,
        state, requested: amount,
        confirmed: confirmed ? amount : null,
        unapplied: confirmed ? (state === 'confirmed' || state === 'unapplied' ? amount : Math.floor(amount / 2)) : null,
        initiatedAt,
        confirmedAt: confirmed ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 3600 * 1000).toISOString() : null,
        failedAt: state === 'failed' ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 60000).toISOString() : null,
        reversedAt: state === 'reversed' ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 86400000).toISOString() : null,
      });
    }
    await insertBatched(conn, 'payments',
      ['id', 'org_id', 'customer_id', 'channel', 'external_ref', 'idempotency_key', 'state',
        'currency', 'requested_minor', 'confirmed_minor', 'unapplied_minor',
        'initiated_at', 'confirmed_at', 'failed_at', 'reversed_at', 'created_at'],
      payments.map((p) => [S(p.id), S(ORG.id), S(p.customer), S(p.channel), S(p.externalRef), S(p.idemKey), S(p.state),
        S('KES'), N(p.requested), N(p.confirmed), N(p.unapplied),
        S(p.initiatedAt), S(p.confirmedAt), S(p.failedAt), S(p.reversedAt), S(p.initiatedAt)]));
    step('payments', payments.length);

    // 5) collections: cases (status mix), R8-safe receivable links, actions.
    function weightedCaseStatus() {
      const r = rand();
      return r < 0.35 ? 'open' : r < 0.60 ? 'in_progress' : r < 0.85 ? 'resolved' : 'closed_inactive';
    }
    const cases = [];
    const caseLinks = [];
    const caseActions = [];
    const usedOpen = new Set(); // open-covered receivable ids (R8: at most one OPEN case each)
    for (let i = 0; i < COUNTS.cases; i++) {
      const status = weightedCaseStatus();
      const openedDaysAgo = ri(0, 500);
      const open = status === 'open' || status === 'in_progress';
      const c = {
        id: uuid(), number: `perf-main-CASE-${i + 1}`, seq: i + 1,
        priority: pick(['low', 'normal', 'normal', 'high', 'urgent']),
        status, owner: users[i % users.length].id,
        openedAt: new Date(BASE_MS - Math.floor(openedDaysAgo * DAY)).toISOString(),
        closedAt: open ? null : new Date(BASE_MS - Math.floor(Math.max(0, openedDaysAgo - 20) * DAY)).toISOString(),
        closedReason: open ? null : pick(['paid_in_full', 'write_off', 'uncollectible']),
      };
      cases.push(c);
      const nLinks = ri(1, 2);
      for (let l = 0; l < nLinks; l++) {
        let idx = ri(0, receivables.length - 1);
        if (open) {
          let guard = 0;
          while (usedOpen.has(receivables[idx].id) && guard++ < receivables.length) idx = (idx + 1) % receivables.length;
          if (usedOpen.has(receivables[idx].id)) break;
          usedOpen.add(receivables[idx].id);
        }
        caseLinks.push({ case: c.id, receivable: receivables[idx].id, at: c.openedAt });
      }
      const nActions = ri(2, 4);
      for (let a = 0; a < nActions; a++) {
        caseActions.push({
          id: uuid(), case: c.id, actor: c.owner,
          action: pick(['call', 'sms', 'whatsapp', 'letter', 'fieldVisit', 'escalation', 'case.opened', 'case.transition']),
          detail: `{"actionId":"${a}","note":"perf fixture"}`,
          performedAt: c.openedAt, seq: a + 1,
        });
      }
    }
    await insertBatched(conn, 'collections_cases',
      ['id', 'org_id', 'case_number', 'priority', 'status', 'owner_id', 'opened_at', 'closed_at', 'closed_reason', 'sequence_no', 'created_at'],
      cases.map((c) => [S(c.id), S(ORG.id), S(c.number), S(c.priority), S(c.status), S(c.owner), S(c.openedAt),
        S(c.closedAt), S(c.closedReason), N(c.seq), S(c.openedAt)]));
    await insertBatched(conn, 'collections_case_receivables',
      ['org_id', 'case_id', 'receivable_id', 'created_at'],
      caseLinks.map((l) => [S(ORG.id), S(l.case), S(l.receivable), S(l.at)]));
    await insertBatched(conn, 'case_actions',
      ['id', 'org_id', 'case_id', 'actor_id', 'action', 'detail', 'performed_at', 'sequence_no', 'created_at'],
      caseActions.map((a) => [S(a.id), S(ORG.id), S(a.case), S(a.actor), S(a.action), S(a.detail),
        S(a.performedAt), N(a.seq), S(a.performedAt)]));
    step('cases + links + actions', cases.length + caseLinks.length + caseActions.length);

    // 5b) ledger: the org's chart of accounts (superset of the kernel's
    //     idempotent confirmation chart — cash-KES/ar-KES use the SAME codes
    //     EnsureConfirmationLedgerSeed would create, ON CONFLICT DO NOTHING
    //     makes both orders safe) + the (payments, asset→asset) matrix row.
    const chart = [
      ['cash-KES', 'Mobile Money Cash (KES)', 'asset'],
      ['ar-KES', 'Accounts Receivable (KES)', 'asset'],
      ['revenue-KES', 'Service Revenue (KES)', 'income'],
      ['fees-KES', 'Transaction Fees (KES)', 'expense'],
      ['tax-payable-KES', 'Tax Payable (KES)', 'liability'],
      ['suspense-KES', 'Suspense (KES)', 'asset'],
      ['equity-KES', 'Paid-in Capital (KES)', 'equity'],
    ];
    await insertBatched(conn, 'ledger_accounts',
      ['org_id', 'code', 'name', 'kind', 'currency', 'created_at', 'updated_at'],
      chart.map(([code, name, kind]) => [S(ORG.id), S(code), S(name), S(kind), S('KES'), S(ts(545)), S(ts(545))]));
    await insertBatched(conn, 'posting_matrix',
      ['org_id', 'source', 'debit_kind', 'credit_kind', 'created_at'],
      [[S(ORG.id), S('payments'), S('asset'), S('asset'), S(ts(545))]]);
    step('ledger chart + matrix', chart.length + 1);

    // Balanced journal lines: every entry is one debit(cash) + one
    // credit(ar) pair in KES — Σdebit == Σcredit per entry is true by
    // construction; trg_ledger_entries_check_r4 (DEFERRABLE, COMMIT-time)
    // proves it. journal_ref stays UNIQUE per (org, ref, line_no).
    // Resolve the chart codes to the account ids the INSERTs above got.
    const chartRes = await q(`SELECT id::text, code FROM ledger_accounts WHERE org_id = '${ORG.id}'`);
    const chartIds = {};
    for (const row of chartRes.rows || []) chartIds[row[1]] = row[0];
    const cashId = chartIds['cash-KES'];
    const arId = chartIds['ar-KES'];
    if (!cashId || !arId) throw new Error('seed: ledger chart missing cash-KES/ar-KES after insert');

    const entries = [];
    for (let i = 0; i < COUNTS.ledgerEntries; i++) {
      const entryId = uuid();
      const amount = ri(100, 50000) * 100;
      const postedDaysAgo = ri(0, 540);
      const postedAt = new Date(BASE_MS - Math.floor(postedDaysAgo * DAY)).toISOString();
      entries.push({ entryId, amount, postedAt, ref: `perf-fixture-payment_confirmed-${i + 1}`, srcRef: `perf-fixture-TX${i + 1}` });
    }
    const entryRows = [];
    for (const e of entries) {
      entryRows.push([S(uuid()), S(ORG.id), S(e.entryId), N(1), S(cashId), S('debit'), N(e.amount), S('KES'),
        S('payments'), S(e.srcRef), S(e.ref), S(e.postedAt)]);
      entryRows.push([S(uuid()), S(ORG.id), S(e.entryId), N(2), S(arId), S('credit'), N(e.amount), S('KES'),
        S('payments'), S(e.srcRef), S(e.ref), S(e.postedAt)]);
    }
    await insertBatched(conn, 'ledger_entries',
      ['id', 'org_id', 'entry_id', 'line_no', 'account_id', 'direction', 'amount_minor', 'currency',
        'source', 'source_ref', 'journal_ref', 'posted_at'],
      entryRows);
    step('ledger entries (balanced)', entryRows.length);

    // 5c) adjustments feed rows: refunds (R6-safe — total ≤ the payment's
    //     confirmed_minor; the payment carries no allocations) + credit
    //     notes (voided ⇒ voided_at NOT NULL, ck_credit_notes_void_shape).
    const refundable = payments.filter((p) => p.confirmed !== null);
    const refunds = [];
    for (let i = 0; i < COUNTS.refunds && refundable.length > 0; i++) {
      const p = refundable[i % refundable.length];
      const state = pick(['requested', 'approved', 'processing', 'completed', 'completed', 'rejected', 'failed']);
      const total = Math.max(100, Math.floor(p.confirmed / 2));
      refunds.push({
        id: uuid(), payment: p.id, state, total,
        externalRef: rand() < 0.8 ? `perf-fixture-RF${i + 1}` : null,
        rejectedReason: state === 'rejected' ? 'refund window elapsed (perf fixture)' : null,
        failedReason: state === 'failed' ? 'b2c timeout (perf fixture)' : null,
        at: new Date(BASE_MS - ri(0, 400) * DAY).toISOString(),
      });
    }
    await insertBatched(conn, 'refunds',
      ['id', 'org_id', 'payment_id', 'requested_by', 'reason', 'state', 'total_minor', 'currency',
        'external_ref', 'rejected_reason', 'failed_reason', 'created_at', 'updated_at'],
      refunds.map((r) => [S(r.id), S(ORG.id), S(r.payment), S(users[2].id),
        S('duplicate deposit (perf fixture)'), S(r.state), N(r.total), S('KES'),
        r.externalRef ? S(r.externalRef) : 'NULL', r.rejectedReason ? S(r.rejectedReason) : 'NULL',
        r.failedReason ? S(r.failedReason) : 'NULL', S(r.at), S(r.at)]));
    step('refunds (R6-safe)', refunds.length);

    const noteStatePlan = [['draft', 0.2], ['issued', 0.5], ['partially_applied', 0.1], ['fully_applied', 0.1], ['voided', 0.1]];
    const noteWeighted = [];
    noteStatePlan.forEach(([s, p]) => { for (let i = 0; i < p * 100; i++) noteWeighted.push(s); });
    const creditNotes = [];
    for (let i = 0; i < COUNTS.creditNotes; i++) {
      const state = noteWeighted[Math.floor(rand() * noteWeighted.length)];
      const at = new Date(BASE_MS - ri(0, 500) * DAY).toISOString();
      creditNotes.push({
        id: uuid(), customer: customers[i % customers.length].id, state,
        total: ri(50, 20000) * 100, at, voidedAt: state === 'voided' ? at : null,
        issuedAt: state !== 'draft' ? at : null,
      });
    }
    await insertBatched(conn, 'credit_notes',
      ['id', 'org_id', 'customer_id', 'reason', 'total_minor', 'currency', 'state',
        'issued_at', 'voided_at', 'created_at', 'updated_at'],
      creditNotes.map((c) => [S(c.id), S(ORG.id), S(c.customer), S('billing correction (perf fixture)'),
        N(c.total), S('KES'), S(c.state), c.issuedAt ? S(c.issuedAt) : 'NULL',
        c.voidedAt ? S(c.voidedAt) : 'NULL', S(c.at), S(c.at)]));
    step('credit notes', creditNotes.length);

    // 6) VACUUM ANALYZE — fresh inserts have no statistics; the planner would
    //    otherwise make the first run look artificially awful.
    await q('VACUUM ANALYZE');

    console.log('seed: done');
    console.log('');
    console.log('seed: harness credentials (FIXTURE-ONLY — never point at a real deployment):');
    console.log(`seed:   export PERF_API_KEY_ID='${HARNESS_KEY_ID}'`);
    console.log(`seed:   export PERF_API_KEY_SECRET='${HARNESS_SECRET}'`);
    console.log(`seed:   export PERF_ORG_SLUG='${ORG.slug}'`);
    console.log('');
    console.log(`seed: fixture shape (scale=${SCALE}): ${COUNTS.customers} customers, ${COUNTS.receivables} receivables, ${COUNTS.payments} payments, ${COUNTS.cases} cases, ${COUNTS.ledgerEntries * 2} ledger lines, ${COUNTS.refunds} refunds, ${COUNTS.creditNotes} credit notes`);
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(`seed: FAILED: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
/**
 * db/seed_explain.cjs — deterministic representative fixture for the 0015
 * read-model-index evidence (issue #137). Stdlib only; talks to PostgreSQL
 * through db/pgclient.cjs (simple-query protocol, one Query message per
 * batch = one implicit transaction per batch).
 *
 * WHY: the /v1 list endpoints paginate on (org_id, created_at, id) and the
 * hot single-row reads probe org-scoped/ledger/queue shapes. Planning evidence
 * is only honest against row counts and skew a real deployment shows, so this
 * seeds ~135k rows with 95%/5% two-org skew, 540-day timestamp spreads and a
 * realistic state mix — then VACUUM ANALYZE.
 *
 * Every row satisfies the schema's own CHECK/trigger discipline (states ⇔
 * timestamps shape, allocation ceilings via the 0006 deferrable proofs, R8
 * one-open-case-per-receivable, webhook terminal shapes). The PRNG is seeded,
 * so re-running on a fresh database reproduces the exact fixture.
 *
 * Usage: node db/seed_explain.cjs [--host H] [--port P] [--user U] [--db D]
 * (connection via PGHOST/PGPORT/PGUSER/PGDATABASE like migrate.cjs).
 * Requires a database already migrated to 0014-state (0001..0014 applied).
 */

const { connect, PgError } = require('./pgclient.cjs');

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
const rand = mulberry32(137137);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// Sequential uuid-v4-shaped ids (stable across runs, unique within the DB).
let uuidCounter = 0;
const UUID_BASE = 'a1370000-0000-4000-8000-';
function uuid() {
  const n = (++uuidCounter).toString(16).padStart(12, '0');
  return UUID_BASE + n;
}
function hex(n) {
  let s = '';
  while (s.length < n) s += Math.floor(rand() * 16).toString(16);
  return s;
}

// Fixed base instant; everything spreads backwards from it (2025-07-01Z).
const BASE_MS = Date.parse('2025-07-01T00:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const ts = (daysAgo) => new Date(BASE_MS - Math.floor(daysAgo * DAY) - ri(0, DAY - 1)).toISOString();

// --- batched INSERT helper -----------------------------------------------------
async function insertBatched(conn, table, columns, rows) {
  const BATCH = 400;
  let done = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const chunk = rows.slice(off, off + BATCH);
    const tuples = chunk
      .map((row) => `(${row.join(', ')})`)
      .join(',\n');
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

// SQL literal helpers (values are pre-rendered per column type).
const S = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const N = (n) => (n === null || n === undefined ? 'NULL' : String(Math.round(n)));
const ARR = (a) => (a === null ? 'NULL' : `'{${a.join(',')}}'`); // text[] input syntax

// --- fixture -------------------------------------------------------------------
const ORGS = [
  { id: uuid(), slug: 'acme-main', name: 'Acme Collections (fixture main)', share: 0.95 },
  { id: uuid(), slug: 'beta-ltd', name: 'Beta Ltd (fixture small)', share: 0.05 },
];

async function main() {
  const opts = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5435),
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE,
  };
  if (!opts.database) {
    console.error('seed: PGDATABASE is required');
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
      console.log(`seed: ${name.padEnd(32)} ${String(n).padStart(7)} rows  ${String((Date.now() - t0) / 1000 | 0).padStart(4)}s`);

    // 0) clean slate (orgs is the tenant root — CASCADE reaches every table;
    //    schema_migrations is FK-independent and survives, as the runner wants).
    await q('TRUNCATE orgs CASCADE');

    await insertBatched(conn, 'orgs', ['id', 'name', 'slug', 'status', 'created_at'],
      ORGS.map((o) => [S(o.id), S(o.name), S(o.slug), S('active'), S(ts(600))]));
    step('orgs', ORGS.length);

    // 1) auth lane: users, roles, grants (+ revoke facts), keys, sessions.
    const users = [];
    const roles = [];
    for (const org of ORGS) {
      const nUsers = org.share > 0.5 ? 290 : 10;
      for (let i = 0; i < nUsers; i++) {
        users.push({
          id: uuid(), org: org.id, email: `collector${users.length}@${org.slug}.test`,
          username: `${org.slug}_u${users.length}`, name: `Collector ${users.length}`,
          status: rand() < 0.93 ? 'active' : (rand() < 0.5 ? 'suspended' : 'deactivated'),
          createdAt: ts(ri(400, 560)),
        });
      }
      ['admin', 'collector', 'finance'].forEach((rn, i) => {
        roles.push({
          id: uuid(), org: org.id, name: `${org.slug}-${rn}`,
          perms: rn === 'admin'
            ? ['receivables:read', 'payments:read', 'payments:intake', 'collections:read', 'collections:act', 'admin:manage-users']
            : rn === 'collector' ? ['receivables:read', 'collections:read', 'collections:act']
              : ['receivables:read', 'payments:read', 'payments:refund'],
          seq: i,
        });
      });
    }
    await insertBatched(conn, 'users',
      ['id', 'org_id', 'email', 'username', 'display_name', 'status', 'password_hash', 'created_at'],
      users.map((u) => [S(u.id), S(u.org), S(u.email), S(u.username), S(u.name), S(u.status), S(`v1-digest-${hex(32)}`), S(u.createdAt)]));
    step('users', users.length);

    await insertBatched(conn, 'roles', ['id', 'org_id', 'name', 'permissions', 'created_at'],
      roles.map((r) => [S(r.id), S(r.org), S(r.name), ARR(r.perms), S(ts(560))]));
    step('roles', roles.length);

    // Grants: every non-deactivated user gets 1-3 role grants; ~45% later
    // carry a revoke FACT (the anti-join the auth path evaluates per request).
    const grants = [];
    const revokes = [];
    for (const u of users) {
      if (u.status === 'deactivated') continue;
      const orgRoles = roles.filter((r) => r.org === u.org);
      const granter = users.find((x) => x.org === u.org && x.id !== u.id);
      const nGrants = ri(1, 3);
      for (let g = 0; g < nGrants; g++) {
        const role = orgRoles[(users.indexOf(u) + g) % orgRoles.length];
        const grant = {
          id: uuid(), org: u.org, user: u.id, role: role.id,
          grantedBy: granter.id, grantedAt: ts(ri(60, 400)),
        };
        grants.push(grant);
        if (rand() < 0.45) {
          revokes.push([grant, uuid(), ts(ri(1, 55))]);
        }
      }
    }
    await insertBatched(conn, 'role_assignments',
      ['id', 'org_id', 'kind', 'user_id', 'role_id', 'resource_id', 'granted_by', 'granted_at'],
      grants.map((g) => [S(g.id), S(g.org), S('grant'), S(g.user), S(g.role), 'NULL', S(g.grantedBy), S(g.grantedAt)]));
    await insertBatched(conn, 'role_assignments',
      ['id', 'org_id', 'kind', 'user_id', 'role_id', 'granted_by', 'granted_at',
        'revoked_grant_id', 'revoked_at', 'revoked_by', 'revoked_reason'],
      revokes.map(([g, rid, at]) => [S(rid), S(g.org), S('revoke'), S(g.user), S(g.role), S(g.grantedBy), S(g.grantedAt),
        S(g.id), S(at), S(g.grantedBy), S('rotation')]));
    step('role_assignments (g+r)', grants.length + revokes.length);

    const apiKeys = [];
    const sessions = [];
    for (const u of users.filter((x) => x.status === 'active')) {
      if (rand() < 0.6) {
        const revoked = rand() >= 0.85;
        apiKeys.push({
          id: uuid(), org: u.org, name: `key-${apiKeys.length}`, createdBy: u.id,
          prefix: hex(8), scopes: ['receivables:read', 'payments:read'],
          status: revoked ? 'revoked' : 'active',
          revokedAt: revoked ? ts(ri(1, 20)) : null,
          createdAt: ts(ri(30, 400)),
        });
      }
      if (rand() < 0.6) {
        const active = rand() < 0.8;
        sessions.push({
          id: uuid(), org: u.org, user: u.id,
          status: active ? 'active' : pick(['ended', 'expired', 'revoked']),
          endedAt: active ? null : ts(ri(0, 30)),
          createdAt: ts(ri(0, 60)), lastSeen: ts(ri(0, 3)),
        });
      }
    }
    await insertBatched(conn, 'api_keys',
      ['key_id', 'org_id', 'name', 'created_by', 'prefix', 'secret_hash', 'scopes', 'status', 'revoked_at', 'created_at'],
      apiKeys.map((k) => [S(k.id), S(k.org), S(k.name), S(k.createdBy), S(k.prefix), S(`sha256$${hex(44)}`), ARR(k.scopes), S(k.status), S(k.revokedAt), S(k.createdAt)]));
    await insertBatched(conn, 'sessions',
      ['session_id', 'org_id', 'user_id', 'idle_timeout_ms', 'absolute_timeout_ms', 'status', 'created_at', 'last_seen_at', 'ended_at'],
      sessions.map((s) => [S(s.id), S(s.org), S(s.user), N(3600000), N(86400000), S(s.status), S(s.createdAt), S(s.lastSeen), S(s.endedAt)]));
    step('api_keys + sessions', apiKeys.length + sessions.length);

    // 2) customers (FK target for invoices/receivables/payments/promises).
    const customers = [];
    for (const org of ORGS) {
      const n = org.share > 0.5 ? 460 : 40;
      for (let i = 0; i < n; i++) {
        customers.push({
          id: uuid(), org: org.id, name: `Customer ${customers.length} Ltd`,
          msisdn: `2547${String(10000000 + customers.length).slice(0, 8)}`,
          status: rand() < 0.95 ? 'active' : 'blocked',
        });
      }
    }
    await insertBatched(conn, 'customers',
      ['id', 'org_id', 'display_name', 'msisdn', 'email', 'segment', 'status', 'created_at'],
      customers.map((c) => [S(c.id), S(c.org), S(c.name), S(c.msisdn), S(`c${c.msisdn}@example.test`),
        S(pick(['vip', 'standard', 'risky'])), S(c.status), S(ts(ri(200, 590)))]));
    step('customers', customers.length);

    // 3) receivables + their invoices. States follow the read model's mix;
    // settled carries applied == original (balance 0), live states get real
    // allocations further down (the 0006 triggers keep applied honest).
    const statePlan = [
      ['open', 0.30], ['partially_paid', 0.24], ['settled', 0.30],
      ['written_off', 0.04], ['uncollectible', 0.04], ['voided', 0.03], ['draft', 0.05],
    ];
    const weighted = [];
    statePlan.forEach(([s, p]) => { for (let i = 0; i < p * 100; i++) weighted.push(s); });
    const receivables = [];
    const invoices = [];
    for (const org of ORGS) {
      const n = org.share > 0.5 ? 19000 : 1000;
      const orgCustomers = customers.filter((c) => c.org === org.id);
      for (let i = 0; i < n; i++) {
        const createdDaysAgo = ri(0, 540);
        const state = weighted[Math.floor(rand() * weighted.length)];
        const invoice = {
          id: uuid(), org: org.id, customer: orgCustomers[i % orgCustomers.length].id,
          total: ri(50, 50000) * 100, due: createdDaysAgo - 30, number: `INV-${invoices.length + 1}`,
        };
        invoices.push(invoice);
        const overdue = (state === 'open' || state === 'partially_paid') && rand() < 0.45;
        receivables.push({
          id: uuid(), org: org.id, invoice: invoice.id, customer: invoice.customer,
          currency: 'KES', original: invoice.total,
          applied: state === 'settled' ? invoice.total : 0,
          state,
          overdue,
          dueDate: new Date(BASE_MS - Math.floor((createdDaysAgo - 30) * DAY)).toISOString(),
          createdAt: new Date(BASE_MS - Math.floor(createdDaysAgo * DAY)).toISOString(),
          writeOffReason: state === 'written_off' ? 'insolvent debtor (fixture)' : null,
          writeOffBy: state === 'written_off' ? 'fixture-admin' : null,
          uncollectibleReason: state === 'uncollectible' ? 'statute-barred (fixture)' : null,
        });
      }
    }
    await insertBatched(conn, 'invoices',
      ['id', 'org_id', 'customer_id', 'status', 'currency', 'total_minor', 'invoice_number', 'issued_at', 'due_date', 'created_at'],
      invoices.map((v) => [S(v.id), S(v.org), S(v.customer), S('issued'), S('KES'), N(v.total), S(v.number),
        S(ts(540)), S(new Date(BASE_MS - Math.floor(v.due * DAY)).toISOString()), S(ts(540))]));
    await insertBatched(conn, 'receivables',
      ['id', 'org_id', 'invoice_id', 'customer_id', 'currency', 'original_minor', 'applied_minor',
        'state', 'overdue', 'opened_at', 'due_date', 'write_off_reason', 'write_off_approved_by',
        'uncollectible_reason', 'created_at'],
      receivables.map((r) => [S(r.id), S(r.org), S(r.invoice), S(r.customer), S(r.currency), N(r.original), N(r.applied),
        S(r.state), S(r.overdue), S(r.createdAt), S(r.dueDate), S(r.writeOffReason), S(r.writeOffBy),
        S(r.uncollectibleReason), S(r.createdAt)]));
    step('invoices + receivables', invoices.length + receivables.length);

    // 4) payments (fund truth) with a realistic state mix.
    const payStatePlan = [
      ['initiated', 0.08], ['pending_confirmation', 0.04], ['confirmed', 0.28],
      ['partially_allocated', 0.18], ['allocated', 0.18], ['unapplied', 0.10],
      ['failed', 0.08], ['reversed', 0.03], ['partially_refunded', 0.02], ['refunded', 0.01],
    ];
    const payWeighted = [];
    payStatePlan.forEach(([s, p]) => { for (let i = 0; i < p * 100; i++) payWeighted.push(s); });
    const CONFIRMED_FAMILY = new Set(['confirmed', 'partially_allocated', 'allocated', 'unapplied', 'partially_refunded', 'refunded', 'reversed']);
    const payments = [];
    for (const org of ORGS) {
      const n = org.share > 0.5 ? 24000 : 1000;
      const orgCustomers = customers.filter((c) => c.org === org.id);
      for (let i = 0; i < n; i++) {
        const state = payWeighted[Math.floor(rand() * payWeighted.length)];
        const confirmed = CONFIRMED_FAMILY.has(state);
        const amount = ri(100, 20000) * 100;
        const initiatedDaysAgo = ri(0, 540);
        const initiatedAt = new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY)).toISOString();
        payments.push({
          id: uuid(), org: org.id,
          customer: rand() < 0.8 ? orgCustomers[i % orgCustomers.length].id : null,
          channel: rand() < 0.7 ? 'c2b' : 'stk',
          externalRef: `${org.slug}-TX${payments.length + 1}`,
          idemKey: `${org.slug}-idem-${payments.length + 1}`,
          state, currency: 'KES', requested: amount,
          confirmed: confirmed ? amount : null,
          unapplied: confirmed ? (state === 'confirmed' || state === 'unapplied' ? amount : Math.floor(amount / 2)) : null,
          initiatedAt,
          confirmedAt: confirmed ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 3600 * 1000).toISOString() : null,
          failedAt: state === 'failed' ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 60000).toISOString() : null,
          reversedAt: state === 'reversed' ? new Date(BASE_MS - Math.floor(initiatedDaysAgo * DAY) + 86400000).toISOString() : null,
        });
      }
    }
    await insertBatched(conn, 'payments',
      ['id', 'org_id', 'customer_id', 'channel', 'external_ref', 'idempotency_key', 'state',
        'currency', 'requested_minor', 'confirmed_minor', 'unapplied_minor',
        'initiated_at', 'confirmed_at', 'failed_at', 'reversed_at', 'created_at'],
      payments.map((p) => [S(p.id), S(p.org), S(p.customer), S(p.channel), S(p.externalRef), S(p.idemKey), S(p.state),
        S(p.currency), N(p.requested), N(p.confirmed), N(p.unapplied),
        S(p.initiatedAt), S(p.confirmedAt), S(p.failedAt), S(p.reversedAt), S(p.initiatedAt)]));
    step('payments', payments.length);

    // 5) allocations (0006 triggers maintain applied_minor; ceilings hold by
    // construction: each payment gives ≤ half its confirmed funds, each
    // receivable never receives beyond its remaining headroom) + refunds on
    // unallocated payments.
    const allocations = [];
    const headroom = new Map(); // receivable id → original − applied so far
    const liveReceivables = receivables.filter((r) => r.org === ORGS[0].id
      && (r.state === 'open' || r.state === 'partially_paid'));
    liveReceivables.forEach((r) => headroom.set(r.id, r.original));
    const allocatablePayments = payments.filter((p) => p.org === ORGS[0].id
      && (p.state === 'partially_allocated' || p.state === 'allocated') && p.confirmed !== null);
    for (const p of allocatablePayments) {
      if (allocations.length >= 26000) break;
      let rec = null;
      let room = 0;
      for (let tries = 0; tries < 8; tries++) {
        const candidate = liveReceivables[ri(0, liveReceivables.length - 1)];
        const r = headroom.get(candidate.id);
        if (r >= 200) { rec = candidate; room = r; break; }
      }
      if (!rec) break;
      const amount = Math.min(Math.max(100, Math.floor(p.confirmed / 2)), room);
      if (amount < 100) continue;
      allocations.push({
        id: uuid(), org: p.org, payment: p.id, receivable: rec.id, amount,
        seq: allocations.length + 1, at: p.initiatedAt,
      });
      headroom.set(rec.id, room - amount);
    }
    await insertBatched(conn, 'allocations',
      ['id', 'org_id', 'source_type', 'source_payment_id', 'source_id', 'receivable_id',
        'amount_minor', 'currency', 'strategy', 'sequence_no', 'allocated_at', 'created_at'],
      allocations.map((a) => [S(a.id), S(a.org), S('payment'), S(a.payment), S(a.payment), S(a.receivable),
        N(a.amount), S('KES'), S('fifo'), N(a.seq), S(a.at), S(a.at)]));
    step('allocations', allocations.length);

    const refundable = payments.filter((p) => p.org === ORGS[0].id
      && (p.state === 'confirmed' || p.state === 'partially_refunded' || p.state === 'refunded') && p.confirmed !== null);
    const refunds = [];
    const usedForRefund = new Set();
    for (let i = 0; i < 800 && refunds.length < 800; i++) {
      const p = refundable[ri(0, refundable.length - 1)];
      if (usedForRefund.has(p.id)) continue; // R6 ceiling: one small refund each
      usedForRefund.add(p.id);
      refunds.push({
        id: uuid(), org: p.org, payment: p.id, by: 'fixture-operator',
        reason: 'customer refund', state: rand() < 0.6 ? 'requested' : pick(['approved', 'rejected', 'failed']),
        total: Math.floor(p.confirmed / 4) + 1, createdAt: p.initiatedAt,
      });
    }
    await insertBatched(conn, 'refunds',
      ['id', 'org_id', 'payment_id', 'requested_by', 'reason', 'state', 'total_minor', 'currency', 'created_at'],
      refunds.map((r) => [S(r.id), S(r.org), S(r.payment), S(r.by), S(r.reason), S(r.state), N(r.total), S('KES'), S(r.createdAt)]));
    step('refunds', refunds.length);

    // 6) collections: cases (frozen identity + status mix), links (R8-safe:
    // at most one OPEN case covers any receivable), append-only actions.
    function weightedCaseStatus() {
      const r = rand();
      return r < 0.35 ? 'open' : r < 0.60 ? 'in_progress' : r < 0.85 ? 'resolved' : 'closed_inactive';
    }
    const cases = [];
    const caseLinks = [];
    const caseActions = [];
    const usedOpenByOrg = new Map(); // org id → Set(open-covered receivable ids)
    for (const org of ORGS) {
      const n = org.share > 0.5 ? 2850 : 150;
      const orgUsers = users.filter((u) => u.org === org.id);
      const orgOpenReceivables = receivables.filter((r) => r.org === org.id && r.state === 'open');
      const orgAllReceivables = receivables.filter((r) => r.org === org.id);
      usedOpenByOrg.set(org.id, new Set());
      for (let i = 0; i < n; i++) {
        const status = weightedCaseStatus();
        const openedDaysAgo = ri(0, 500);
        const open = status === 'open' || status === 'in_progress';
        const c = {
          id: uuid(), org: org.id, number: `${org.slug}-CASE-${cases.length + 1}`,
          seq: i + 1, priority: pick(['low', 'normal', 'normal', 'high', 'urgent']),
          status, owner: orgUsers[i % orgUsers.length].id,
          openedAt: new Date(BASE_MS - Math.floor(openedDaysAgo * DAY)).toISOString(),
          closedAt: open ? null : new Date(BASE_MS - Math.floor(Math.max(0, openedDaysAgo - 20) * DAY)).toISOString(),
          closedReason: open ? null : pick(['paid_in_full', 'write_off', 'uncollectible']),
        };
        cases.push(c);
        const usedOpen = usedOpenByOrg.get(org.id);
        const pool = open ? orgOpenReceivables : orgAllReceivables;
        const nLinks = ri(1, 2);
        for (let l = 0; l < nLinks; l++) {
          let idx = ri(0, pool.length - 1);
          if (open) {
            // R8: find an open receivable no other OPEN case covers yet.
            let guard = 0;
            while (usedOpen.has(pool[idx].id) && guard++ < pool.length) idx = (idx + 1) % pool.length;
            if (usedOpen.has(pool[idx].id)) break;
            usedOpen.add(pool[idx].id);
          }
          caseLinks.push({ org: org.id, case: c.id, receivable: pool[idx].id, at: c.openedAt });
        }
        const nActions = ri(2, 4);
        for (let a = 0; a < nActions; a++) {
          caseActions.push({
            id: uuid(), org: org.id, case: c.id, actor: c.owner,
            action: pick(['call', 'sms', 'whatsapp', 'letter', 'fieldVisit', 'escalation', 'case.opened', 'case.transition']),
            detail: `{"actionId":"${hex(12)}","note":"fixture"}`,
            performedAt: c.openedAt, seq: a + 1,
          });
        }
      }
    }
    await insertBatched(conn, 'collections_cases',
      ['id', 'org_id', 'case_number', 'priority', 'status', 'owner_id', 'opened_at', 'closed_at', 'closed_reason', 'sequence_no', 'created_at'],
      cases.map((c) => [S(c.id), S(c.org), S(c.number), S(c.priority), S(c.status), S(c.owner), S(c.openedAt),
        S(c.closedAt), S(c.closedReason), N(c.seq), S(c.openedAt)]));
    await insertBatched(conn, 'collections_case_receivables',
      ['org_id', 'case_id', 'receivable_id', 'created_at'],
      caseLinks.map((l) => [S(l.org), S(l.case), S(l.receivable), S(l.at)]));
    await insertBatched(conn, 'case_actions',
      ['id', 'org_id', 'case_id', 'actor_id', 'action', 'detail', 'performed_at', 'sequence_no', 'created_at'],
      caseActions.map((a) => [S(a.id), S(a.org), S(a.case), S(a.actor), S(a.action), S(a.detail),
        S(a.performedAt), N(a.seq), S(a.performedAt)]));
    step('cases + links + actions', cases.length + caseLinks.length + caseActions.length);

    // 7) promises (the pending-promise overlay scans these).
    const receivableById = new Map(receivables.map((r) => [r.id, r]));
    const promises = [];
    const promiseStates = ['created', 'pending', 'partially_fulfilled', 'created', 'pending', 'fulfilled', 'broken', 'cancelled', 'expired'];
    for (const l of caseLinks.slice(0, 3200)) {
      const state = promiseStates[Math.floor(rand() * promiseStates.length)];
      const rec = receivableById.get(l.receivable);
      const promised = ri(10, 5000) * 100;
      promises.push({
        id: uuid(), org: l.org, customer: rec.customer, receivable: rec.id,
        promised, state,
        promisedFor: ts(ri(1, 90)),
        fulfilled: state === 'fulfilled' ? ri(1, Math.floor(promised / 100)) * 100 : 0,
        brokenAt: state === 'broken' ? ts(ri(1, 30)) : null,
        seq: promises.length + 1, createdAt: ts(ri(1, 120)),
      });
    }
    await insertBatched(conn, 'promises',
      ['id', 'org_id', 'customer_id', 'receivable_id', 'promised_minor', 'currency', 'state',
        'promised_for', 'fulfilled_minor', 'broken_at', 'sequence_no', 'created_at'],
      promises.map((p) => [S(p.id), S(p.org), S(p.customer), S(p.receivable), N(p.promised), S('KES'), S(p.state),
        S(p.promisedFor), N(p.fulfilled), S(p.brokenAt), N(p.seq), S(p.createdAt)]));
    step('promises', promises.length);

    // 8) webhooks: endpoints (2 active / 1 off) + the delivery queue the
    // worker claims from (queued / failed / delivering-lease / terminal).
    const endpoints = [];
    for (let i = 0; i < 3; i++) {
      endpoints.push({
        id: uuid(), org: ORGS[0].id, url: `https://hooks.fixture-${i}.example.africa/v1/events`,
        secret: `sha256$${hex(44)}`, prefix: hex(8), active: i < 2,
      });
    }
    await insertBatched(conn, 'webhook_endpoints',
      ['id', 'org_id', 'url', 'description', 'secret_hash', 'secret_prefix', 'active', 'created_at'],
      endpoints.map((e) => [S(e.id), S(e.org), S(e.url), S(`fixture endpoint ${e.active ? 'on' : 'off'}`),
        S(e.secret), S(e.prefix), S(e.active), S(ts(500))]));
    const deliveries = [];
    const activeEndpoints = endpoints.filter((e) => e.active);
    for (let i = 0; i < 12000; i++) {
      const r = rand();
      const state = r < 0.33 ? 'queued' : r < 0.50 ? 'failed' : r < 0.53 ? 'delivering'
        : r < 0.90 ? 'delivered' : 'dead_lettered';
      const ep = activeEndpoints[i % activeEndpoints.length];
      const createdDaysAgo = ri(0, 30);
      const created = new Date(BASE_MS - Math.floor(createdDaysAgo * DAY) - ri(0, DAY - 1)).toISOString();
      let nextAttempt = null;
      let deliveredAt = null;
      let deadLetteredAt = null;
      if (state === 'queued' || state === 'failed') {
        // Operational steady state: the worker drains due rows every tick, so
        // only a small slice is due NOW (a backlog would mean the worker is
        // down); the rest is scheduled in the future. Times are relative to
        // the SEED instant (not the fixture base) so due/future stays honest
        // whenever the evidence run happens.
        nextAttempt = rand() < 0.05
          ? new Date(Date.now() - ri(1, 7200) * 1000).toISOString()
          : new Date(Date.now() + ri(600, 5 * 86400) * 1000).toISOString();
      }
      if (state === 'delivered') deliveredAt = created;
      if (state === 'dead_lettered') deadLetteredAt = created;
      const delivering = state === 'delivering';
      deliveries.push({
        id: uuid(), org: ep.org, endpoint: ep.id, event: uuid(),
        eventType: pick(['payment.confirmed', 'payment.initiated', 'case.opened', 'case.resolved', 'receivable.settled']),
        payload: `{"eventId":"${hex(16)}","orgId":"fixture"}`,
        state, attempts: state === 'queued' ? 0 : ri(1, 5),
        nextAttempt, deliveredAt, deadLetteredAt,
        lastError: state === 'failed' || state === 'dead_lettered' ? 'connect ETIMEDOUT (fixture)' : null,
        // delivering rows age past the 15-min claim lease → the recovery branch
        createdAt: delivering ? new Date(Date.now() - ri(60, 900) * 1000).toISOString() : created,
        updatedAt: delivering ? new Date(Date.now() - ri(1200, 7200) * 1000).toISOString() : created,
      });
    }
    await insertBatched(conn, 'webhook_deliveries',
      ['id', 'org_id', 'endpoint_id', 'event_id', 'event_type', 'payload', 'state',
        'attempt_count', 'next_attempt_at', 'delivered_at', 'dead_lettered_at', 'last_error',
        'created_at', 'updated_at'],
      deliveries.map((d) => [S(d.id), S(d.org), S(d.endpoint), S(d.event), S(d.eventType), S(d.payload),
        S(d.state), N(d.attempts), S(d.nextAttempt), S(d.deliveredAt), S(d.deadLetteredAt), S(d.lastError),
        S(d.createdAt), S(d.updatedAt)]));
    step('webhook endpoints + deliveries', endpoints.length + deliveries.length);

    // 9) audit chain rows (per-org seq), outbox, idempotency keys.
    const audits = [];
    const outbox = [];
    const idem = [];
    for (const org of ORGS) {
      const nAudit = org.share > 0.5 ? 19000 : 1000;
      for (let i = 1; i <= nAudit; i++) {
        audits.push({
          org: org.id, seq: i, actorType: pick(['user', 'system', 'api', 'agent']),
          actor: hex(12), action: pick(['auth.authenticated', 'payment.confirmed', 'payment.initiated',
            'case.opened', 'case.transitioned', 'receivable.voided', 'refund.requested']),
          resource: pick(['payment', 'case', 'receivable', 'refund', 'session']),
          resourceId: hex(12), hash: hex(64), prevHash: hex(64),
          occurred: ts(ri(0, 540)),
        });
      }
      for (let i = 1; i <= (org.share > 0.5 ? 4700 : 300); i++) {
        const status = i % 3 === 0 ? 'pending' : 'published';
        outbox.push({
          id: uuid(), org: org.id, event: uuid(),
          eventType: pick(['payment.confirmed', 'payment.initiated', 'case.opened', 'case.resolved']),
          payload: `{"seq":${i}}`, status,
          publishedAt: status === 'published' ? ts(ri(0, 30)) : null,
          createdAt: ts(ri(0, 40)),
        });
      }
      for (let i = 1; i <= (org.share > 0.5 ? 1800 : 200); i++) {
        idem.push({
          id: uuid(), org: org.id, scope: 'payments.intake', key: `${org.slug}-idem-${i}`,
          outcome: uuid(), createdAt: ts(ri(0, 200)),
        });
      }
    }
    await insertBatched(conn, 'audit_events',
      ['org_id', 'actor_type', 'actor_id', 'action', 'resource', 'resource_id', 'seq', 'prev_hash', 'hash', 'occurred_at', 'created_at'],
      audits.map((a) => [S(a.org), S(a.actorType), S(a.actor), S(a.action), S(a.resource), S(a.resourceId),
        N(a.seq), S(a.prevHash), S(a.hash), S(a.occurred), S(a.occurred)]));
    await insertBatched(conn, 'outbox_events',
      ['id', 'org_id', 'event_id', 'event_type', 'payload', 'status', 'published_at', 'created_at'],
      outbox.map((o) => [S(o.id), S(o.org), S(o.event), S(o.eventType), S(o.payload), S(o.status),
        S(o.publishedAt), S(o.createdAt)]));
    await insertBatched(conn, 'idempotency_keys',
      ['id', 'org_id', 'scope', 'key', 'outcome_ref', 'created_at'],
      idem.map((k) => [S(k.id), S(k.org), S(k.scope), S(k.key), S(k.outcome), S(k.createdAt)]));
    step('audit + outbox + idempotency', audits.length + outbox.length + idem.length);

    // 10) planner-honest stats: steady-state production runs VACUUMed.
    await q('VACUUM ANALYZE');

    const total = 2 + users.length + roles.length + grants.length + revokes.length
      + apiKeys.length + sessions.length + customers.length + invoices.length + receivables.length
      + payments.length + allocations.length + refunds.length + cases.length + caseLinks.length
      + caseActions.length + promises.length + endpoints.length + deliveries.length
      + audits.length + outbox.length + idem.length;
    console.log(`seed: done — ${total} rows in ${(Date.now() - t0) / 1000 | 0}s (PRNG seed 137137, deterministic)`);
    process.exit(0);
  } finally {
    await conn.end();
  }
}

main();

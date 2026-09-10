#!/usr/bin/env node
'use strict';
/**
 * db/explain_179.cjs — EXPLAIN ANALYZE evidence runner for issue #179:
 * the audit-chain append query shape + the subsumed idx_payments_initiated_at
 * drop (migration 0016). Stdlib only, via db/pgclient.cjs.
 *
 * Captures, against the seeded fixture (db/seed_explain.cjs):
 *   AUDIT-OLD        appendAuditTx's chain-head probe BEFORE #179 — the
 *                    `org_id IS NOT DISTINCT FROM $1` aggregate that filters
 *                    the whole audit_events chain (O(chain) per command);
 *   AUDIT-NEW-ORG    the bindable replacement for org-scoped denials —
 *                    `WHERE org_id = $1 ORDER BY seq DESC LIMIT 1`, a
 *                    backward probe of uq_audit_events_org_seq;
 *   AUDIT-NEW-NULLORG the pre-authentication denial variant —
 *                    `WHERE org_id IS NULL` (its own bindable shape);
 *   PAY-SORT         GET /v1/payments?sort=initiatedAt — the query whose
 *                    carrier changes at 0016 (idx_payments_initiated_at →
 *                    idx_payments_org_initiated alone).
 *
 * Run on a 0015-state database (BEFORE — idx_payments_initiated_at still
 * present) and again after applying 0016 (AFTER) and diff:
 *
 *   node db/explain_179.cjs before > db/explain/0016-before.txt
 *   node db/migrate.cjs ...          # applies 0016
 *   node db/explain_179.cjs after  > db/explain/0016-after.txt
 *
 * The runner never writes (reads + EXPLAIN only).
 */

const { connect } = require('./pgclient.cjs');

const TAG = process.argv[2] || 'untagged';

async function main() {
  const opts = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5435),
    user: process.env.PGUSER || 'postgres',
    database: process.env.PGDATABASE,
  };
  if (!opts.database) {
    console.error('explain_179: PGDATABASE is required');
    process.exit(2);
  }
  const conn = await connect(opts).catch((e) => {
    console.error(`explain_179: CONNECT-FAILED ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${e.message}`);
    process.exit(2);
  });

  try {
    const q = async (sql) => (await conn.query(sql)).rows;
    const one = async (sql) => {
      const rows = await q(sql);
      if (!rows.length || rows[0][0] == null) throw new Error(`explain_179: no row for: ${sql.slice(0, 90)}…`);
      return rows[0][0];
    };

    const org = await one(`SELECT id::text FROM orgs WHERE slug = 'acme-main'`);

    const paymentColumns = `SELECT id, org_id, customer_id, channel, external_ref, idempotency_key, state,
        currency, requested_minor, confirmed_minor, unapplied_minor, declared_refs,
        initiated_at, confirmed_at, failed_at, failure_code, reversed_at, reversal_reason`;

    // infra.appendAuditTx BEFORE #179 — the chain-head aggregate verbatim
    // (org literal inlined; pgx binds it as $1).
    const auditOldSQL = `
SELECT COALESCE(MAX(seq), 0),
       (SELECT hash FROM audit_events WHERE org_id IS NOT DISTINCT FROM '${org}' ORDER BY seq DESC LIMIT 1)
FROM audit_events WHERE org_id IS NOT DISTINCT FROM '${org}'`;

    // infra.appendAuditTx AFTER #179 — bindable probes (org-scoped + null-org).
    const auditNewOrgSQL = `
SELECT seq, hash FROM audit_events WHERE org_id = '${org}' ORDER BY seq DESC LIMIT 1`;
    const auditNewNullOrgSQL = `
SELECT seq, hash FROM audit_events WHERE org_id IS NULL ORDER BY seq DESC LIMIT 1`;

    const SUITE = [
      {
        id: 'AUDIT-OLD',
        title: 'audit chain head per consequential command — BEFORE #179 (IS NOT DISTINCT FROM, unbindable)',
        repo: 'infra.appendAuditTx (pre-#179)',
        sql: auditOldSQL,
      },
      {
        id: 'AUDIT-NEW-ORG',
        title: 'audit chain head — AFTER #179: bindable org_id = $1 probe (org-scoped denials)',
        repo: 'infra.appendAuditTx (auditChainHeadByOrg)',
        sql: auditNewOrgSQL,
      },
      {
        id: 'AUDIT-NEW-NULLORG',
        title: 'audit chain head — AFTER #179: bindable org_id IS NULL probe (pre-auth denials)',
        repo: 'infra.appendAuditTx (auditChainHeadNullOrg)',
        sql: auditNewNullOrgSQL,
      },
      {
        id: 'PAY-SORT',
        title: 'GET /v1/payments?sort=initiatedAt&order=desc — whitelisted sort (carrier changes at 0016)',
        repo: 'repositories.PaymentsByOrg (sortCol="initiated_at", desc)',
        sql: `${paymentColumns} FROM payments WHERE org_id = '${org}' ORDER BY initiated_at desc, id LIMIT 25 OFFSET 0`,
      },
    ];

    console.log(`# EXPLAIN ANALYZE evidence — 0016: audit-chain append shape + subsumed index drop (issue #179)`);
    console.log(`# tag:      ${TAG}`);
    const ver = await q(`SELECT version()`);
    const counts = await q(`
      SELECT (SELECT count(*) FROM audit_events WHERE org_id = '${org}') AS audit_main_org,
             (SELECT count(*) FROM audit_events)                          AS audit_all,
             (SELECT count(*) FROM audit_events WHERE org_id IS NULL)     AS audit_null_org,
             (SELECT count(*) FROM payments)                              AS payments_all`);
    const indexes = await q(`
      SELECT indexname FROM pg_indexes
       WHERE (tablename = 'audit_events' AND indexname LIKE 'uq_audit%')
          OR (tablename = 'payments' AND indexname LIKE 'idx_payments%')
       ORDER BY tablename DESC, indexname`);
    console.log(`# server:  ${ver[0][0].split(' on ')[0]}`);
    console.log(`# fixture: ${counts[0].join(' | ')}  (audit_main_org | audit_all | audit_null_org | payments_all)`);
    console.log(`# indexes: ${indexes.map((r) => r[0]).join(', ')}`);
    console.log(`# params:  org=${org}`);
    console.log('');

    const summary = [];
    for (const item of SUITE) {
      console.log('='.repeat(86));
      console.log(`${item.id}  ${item.title}`);
      console.log(`    repo: ${item.repo}`);
      // Warm-up executions (plan cache / shared buffers).
      await conn.query(item.sql);
      await conn.query(item.sql);
      const plan = await conn.query(`EXPLAIN (ANALYZE, BUFFERS) ${item.sql}`);
      const text = plan.rows.map((r) => r[0]).join('\n');
      console.log(text);
      const exec = (text.match(/Execution Time: ([\d.]+) ms/) || [])[1];
      const peak = (text.match(/Peak Memory Usage[^:]*: (\d+) kB/) || [])[1];
      summary.push([item.id, exec ? `${exec} ms` : '?', peak ? `${peak} kB` : '?']);
      console.log('');
    }

    console.log('='.repeat(86));
    console.log(`SUMMARY (${TAG}) — execution time after warm-up`);
    for (const [id, exec, peak] of summary) {
      console.log(`  ${id.padEnd(16)} ${exec.padStart(10)}   peak ${peak}`);
    }
    process.exit(0);
  } finally {
    await conn.end();
  }
}

main();

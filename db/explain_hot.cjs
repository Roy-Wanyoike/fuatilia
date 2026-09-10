#!/usr/bin/env node
'use strict';
/**
 * db/explain_hot.cjs — EXPLAIN ANALYZE evidence runner for the 0015
 * read-model indexes (issue #137). Stdlib only, via db/pgclient.cjs.
 *
 * Runs the HOT queries the mounted /v1 surface (and the webhook worker)
 * actually execute — the SQL is lifted verbatim from
 * backend-go/internal/repositories/** and webhooks/store.go with the
 * prepared-statement parameters inlined as literals — against the seeded
 * fixture (db/seed_explain.cjs). Each query is executed once to warm caches,
 * then captured as EXPLAIN (ANALYZE, BUFFERS). Run it on a 0014-state
 * database (BEFORE) and again after applying 0015 (AFTER) and diff:
 *
 *   node db/explain_hot.cjs > db/explain/0015-before.txt
 *   # apply 0015: node db/migrate.cjs ...
 *   node db/explain_hot.cjs > db/explain/0015-after.txt
 *
 * The FOR UPDATE SKIP LOCKED claim query runs inside BEGIN/ROLLBACK so the
 * evidence run cannot mutate the fixture.
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
    console.error('explain_hot: PGDATABASE is required');
    process.exit(2);
  }
  const conn = await connect(opts).catch((e) => {
    console.error(`explain_hot: CONNECT-FAILED ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${e.message}`);
    process.exit(2);
  });

  try {
    const q = async (sql) => (await conn.query(sql)).rows;
    const one = async (sql) => {
      const rows = await q(sql);
      if (!rows.length || rows[0][0] == null) throw new Error(`explain_hot: no row for: ${sql.slice(0, 90)}…`);
      return rows[0][0];
    };

    // --- representative parameters (the seed's skewed main org) --------------
    const org = await one(`SELECT id::text FROM orgs WHERE slug = 'acme-main'`);
    const paymentId = await one(`
      SELECT a.source_id::text
        FROM allocations a
       WHERE a.org_id = '${org}' AND a.source_type = 'payment' AND a.reversed_at IS NULL
       GROUP BY a.source_id ORDER BY count(*) DESC, a.source_id LIMIT 1`);
    const caseId = await one(`
      SELECT l.case_id::text
        FROM collections_case_receivables l
       WHERE l.org_id = '${org}'
       GROUP BY l.case_id ORDER BY count(*) DESC, l.case_id LIMIT 1`);
    const userId = await one(`
      SELECT ra.user_id::text
        FROM role_assignments ra
       WHERE ra.org_id = '${org}' AND ra.kind = 'grant'
       GROUP BY ra.user_id ORDER BY count(*) DESC, ra.user_id LIMIT 1`);
    const receivableIds = (await q(`
      SELECT receivable_id::text FROM collections_case_receivables
       WHERE org_id = '${org}' AND case_id = '${caseId}'`)).map((r) => r[0]);
    const anyArray = receivableIds.length
      ? `ARRAY[${receivableIds.map((x) => `'${x}'`).join(',')}]::uuid[]`
      : `ARRAY[]::uuid[]`;

    // --- the hot statements (repo SQL, parameters inlined) --------------------
    const receivableColumns = `SELECT id, org_id, invoice_id, customer_id, currency, original_minor, applied_minor,
        balance_minor, state, overdue, opened_at, due_date, settled_at, voided_at,
        write_off_reason, write_off_approved_by, write_off_at, uncollectible_reason,
        uncollectible_at, recovered_at, created_at`;
    const paymentColumns = `SELECT id, org_id, customer_id, channel, external_ref, idempotency_key, state,
        currency, requested_minor, confirmed_minor, unapplied_minor, declared_refs,
        initiated_at, confirmed_at, failed_at, failure_code, reversed_at, reversal_reason`;
    const caseColumns = `SELECT id, org_id, case_number, sequence_no, priority, status, owner_id, opened_at, closed_at, closed_reason`;

    const claimDueSQL = `
SELECT d.id::text, d.org_id::text, d.endpoint_id::text, d.event_id::text,
       d.event_type, d.payload::text, d.attempt_count, d.created_at, e.url
  FROM webhook_deliveries d
  JOIN webhook_endpoints  e ON e.org_id = d.org_id AND e.id = d.endpoint_id
 WHERE e.active
   AND (
        (d.state IN ('queued', 'failed')
         AND COALESCE(d.next_attempt_at, d.created_at) <= now())
        OR
        (d.state = 'delivering' AND d.updated_at <= now() - interval '15 minutes')
       )
 ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.created_at, d.id
 LIMIT 1
   FOR UPDATE OF d SKIP LOCKED`;

    const SUITE = [
      {
        id: 'Q1',
        title: 'GET /v1/receivables — first page, default sort (limit 25, offset 0)',
        repo: 'repositories.ReceivablesByOrg (sortCol="created_at", asc)',
        sql: `${receivableColumns} FROM receivables WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 0`,
      },
      {
        id: 'Q1b',
        title: 'GET /v1/receivables — deep page (offset 15000) + org count(*)',
        repo: 'repositories.ReceivablesByOrg + count',
        sql: `${receivableColumns} FROM receivables WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 15000`,
      },
      {
        id: 'Q1c',
        title: 'GET /v1/receivables — the paginatedMeta total',
        repo: 'repositories.ReceivablesByOrg count',
        sql: `SELECT count(*) FROM receivables WHERE org_id = '${org}'`,
      },
      {
        id: 'Q2',
        title: 'GET /v1/receivables?sort=dueDate&order=desc — whitelisted sort',
        repo: 'repositories.ReceivablesByOrg (sortCol="due_date", desc)',
        sql: `${receivableColumns} FROM receivables WHERE org_id = '${org}' ORDER BY due_date desc, id LIMIT 25 OFFSET 0`,
      },
      {
        id: 'Q3',
        title: 'GET /v1/payments — first page, default sort (limit 25, offset 0)',
        repo: 'repositories.PaymentsByOrg',
        sql: `${paymentColumns} FROM payments WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 0`,
      },
      {
        id: 'Q3b',
        title: 'GET /v1/payments — deep page (offset 20000), default sort',
        repo: 'repositories.PaymentsByOrg',
        sql: `${paymentColumns} FROM payments WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 20000`,
      },
      {
        id: 'Q3d',
        title: 'GET /v1/payments?sort=initiatedAt&order=desc — whitelisted sort',
        repo: 'repositories.PaymentsByOrg (sortCol="initiated_at", desc)',
        sql: `${paymentColumns} FROM payments WHERE org_id = '${org}' ORDER BY initiated_at desc, id LIMIT 25 OFFSET 0`,
      },
      {
        id: 'Q3c',
        title: 'GET /v1/payments — the paginatedMeta total',
        repo: 'repositories.PaymentsByOrg count',
        sql: `SELECT count(*) FROM payments WHERE org_id = '${org}'`,
      },
      {
        id: 'Q4',
        title: 'GET /v1/payments/:paymentId — the payment row',
        repo: 'repositories.PaymentByID',
        sql: `${paymentColumns} FROM payments WHERE org_id = '${org}' AND id = '${paymentId}'`,
      },
      {
        id: 'Q4b',
        title: 'GET /v1/payments/:paymentId — live allocations (ordered)',
        repo: 'repositories.AllocationsForPayment (+ CommittedAgainstPayment input)',
        sql: `SELECT id::text, receivable_id::text, amount_minor, currency, allocated_at
                   FROM allocations
                  WHERE org_id = '${org}' AND source_type = 'payment' AND source_id = '${paymentId}'
                    AND reversed_at IS NULL
                  ORDER BY allocated_at, id`,
      },
      {
        id: 'Q4c',
        title: 'GET /v1/payments/:paymentId — refund reservations (ordered)',
        repo: 'repositories.RefundsForPayment',
        sql: `SELECT id::text, payment_id::text, total_minor, currency, reason, state, created_at
                   FROM refunds WHERE org_id = '${org}' AND payment_id = '${paymentId}'
                  ORDER BY created_at, id`,
      },
      {
        id: 'Q5',
        title: 'GET /v1/collections/cases — first page, default sort (limit 25, offset 0)',
        repo: 'repositories.CasesByOrg',
        sql: `${caseColumns} FROM collections_cases WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 0`,
      },
      {
        id: 'Q5b',
        title: 'GET /v1/collections/cases — deep page (offset 2500), default sort',
        repo: 'repositories.CasesByOrg',
        sql: `${caseColumns} FROM collections_cases WHERE org_id = '${org}' ORDER BY created_at asc, id LIMIT 25 OFFSET 2500`,
      },
      {
        id: 'Q6',
        title: 'GET /v1/collections/cases/:caseId — the case row',
        repo: 'repositories.CaseByID',
        sql: `${caseColumns} FROM collections_cases WHERE org_id = '${org}' AND id = '${caseId}'`,
      },
      {
        id: 'Q6b',
        title: 'GET /v1/collections/cases/:caseId — append-only action log',
        repo: 'repositories.CaseActionLog',
        sql: `SELECT id::text, case_id::text, actor_id, action, detail, performed_at, sequence_no
                   FROM case_actions WHERE org_id = '${org}' AND case_id = '${caseId}'
                  ORDER BY sequence_no`,
      },
      {
        id: 'Q6c',
        title: 'GET /v1/collections/cases/:caseId — pending-promise overlay',
        repo: 'repositories.CaseHasPendingPromise',
        sql: `SELECT EXISTS (SELECT 1 FROM promises
                  WHERE org_id = '${org}' AND receivable_id = ANY(${anyArray})
                    AND state IN ('created', 'pending', 'partially_fulfilled'))`,
      },
      {
        id: 'Q7',
        title: 'AUTH HOT PATH (every authenticated request) — grant projection anti-join',
        repo: 'repositories.AuthStore.ActiveRulesForUser',
        sql: `SELECT r.permissions, ra.resource_id
                   FROM role_assignments ra
                   JOIN roles r ON r.org_id = ra.org_id AND r.id = ra.role_id
                  WHERE ra.org_id = '${org}' AND ra.user_id = '${userId}' AND ra.kind = 'grant'
                    AND NOT EXISTS (SELECT 1 FROM role_assignments rv WHERE rv.revoked_grant_id = ra.id)`,
      },
      {
        id: 'Q8',
        title: 'WEBHOOK WORKER ClaimDue — cross-org claim, FOR UPDATE SKIP LOCKED',
        repo: 'webhooks.Store.ClaimDue (claimDueSQL, lease=15m)',
        tx: true,
        sql: claimDueSQL,
      },
      {
        id: 'CTX',
        title: 'CONTEXT (unchanged by 0015) — audit chain head per consequential command',
        repo: 'infra.appendAuditTx',
        sql: `SELECT COALESCE(MAX(seq), 0),
                (SELECT hash FROM audit_events WHERE org_id IS NOT DISTINCT FROM '${org}' ORDER BY seq DESC LIMIT 1)
                FROM audit_events WHERE org_id IS NOT DISTINCT FROM '${org}'`,
      },
    ];

    console.log(`# EXPLAIN ANALYZE evidence — 0015 read-model indexes (issue #137)`);
    console.log(`# tag:      ${TAG}`);
    const ver = await q(`SELECT version()`);
    const counts = await q(`
      SELECT (SELECT count(*) FROM receivables WHERE org_id = '${org}')  AS receivables_main_org,
             (SELECT count(*) FROM receivables)                          AS receivables_all,
             (SELECT count(*) FROM payments)                             AS payments_all,
             (SELECT count(*) FROM collections_cases)                    AS cases_all,
             (SELECT count(*) FROM allocations WHERE reversed_at IS NULL) AS allocations_live,
             (SELECT count(*) FROM role_assignments)                     AS role_assignments,
             (SELECT count(*) FROM webhook_deliveries)                   AS webhook_deliveries,
             (SELECT count(*) FROM promises WHERE state IN ('created','pending','partially_fulfilled')) AS promises_open`);
    console.log(`# server:  ${ver[0][0].split(' on ')[0]}`);
    console.log(`# fixture: ${counts[0].join(' | ')}  (receivables_main_org | receivables_all | payments_all | cases_all | allocations_live | role_assignments | webhook_deliveries | promises_open)`);
    console.log(`# params:  org=${org} payment=${paymentId} case=${caseId} user=${userId} receivables=${receivableIds.length}`);
    console.log('');

    const summary = [];
    for (const item of SUITE) {
      console.log('='.repeat(86));
      console.log(`${item.id}  ${item.title}`);
      console.log(`    repo: ${item.repo}`);
      // Warm-up executions (plan cache / shared buffers); claim runs in a tx.
      if (item.tx) {
        await conn.query('BEGIN');
        await conn.query(item.sql);
        await conn.query('ROLLBACK');
        await conn.query('BEGIN');
        await conn.query(item.sql);
        await conn.query('ROLLBACK');
      } else {
        await conn.query(item.sql);
        await conn.query(item.sql);
      }
      let plan;
      if (item.tx) {
        await conn.query('BEGIN');
        plan = await conn.query(`EXPLAIN (ANALYZE, BUFFERS) ${item.sql}`);
        await conn.query('ROLLBACK');
      } else {
        plan = await conn.query(`EXPLAIN (ANALYZE, BUFFERS) ${item.sql}`);
      }
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
      console.log(`  ${id.padEnd(4)} ${exec.padStart(10)}   peak ${peak}`);
    }
    process.exit(0);
  } finally {
    await conn.end();
  }
}

main();

#!/usr/bin/env node
'use strict';
/**
 * db/migrate.cjs — forward-only migration runner (stdlib only).
 *
 * Applies db/migrations/*.sql in lexical order. Applied versions are tracked
 * in the `schema_migrations` table (suite-level idempotency, per issue #66):
 * a migration that is already recorded is SKIPPED, so running the suite twice
 * is a no-op the second time — this is what db/validate.sh proves.
 *
 * Each migration file is executed as ONE Query message = ONE implicit
 * transaction: a file either fully applies or leaves no trace.
 *
 * Usage: node db/migrate.cjs [--migrations-dir db/migrations]
 *   (connection via --host/--port/--user/--db or PGHOST/PGPORT/PGUSER/PGDATABASE)
 */

const fs = require('fs');
const path = require('path');
const { connect, PgError } = require('./pgclient.cjs');

function parseArgs(argv) {
  const out = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    dir: path.join(__dirname, 'migrations'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--host') out.host = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--user') out.user = next();
    else if (a === '--db') out.database = next();
    else if (a === '--migrations-dir') out.dir = path.resolve(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.user || !out.database) throw new Error('--user/--db (or PGUSER/PGDATABASE) are required');
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(`migrate: ${e.message}`);
    process.exit(2);
  }

  const files = fs
    .readdirSync(opts.dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.error(`migrate: no .sql migrations found in ${opts.dir}`);
    process.exit(2);
  }

  const conn = await connect(opts).catch((e) => {
    console.error(`migrate: CONNECT-FAILED ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${e.message}`);
    process.exit(2);
  });

  try {
    // Suite-level idempotency tracking (issue #66: schema_migrations).
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        text PRIMARY KEY,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const probe = async (name) => {
      try {
        await conn.query(
          `DO $$
           BEGIN
             IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '${name.replace(/'/g, "''")}') THEN
               RAISE EXCEPTION 'MIGRATION_NOT_APPLIED';
             END IF;
           END $$`,
        );
        return true;
      } catch (e) {
        if (e instanceof PgError && e.message.includes('MIGRATION_NOT_APPLIED')) return false;
        throw e;
      }
    };

    let applied = 0;
    let skipped = 0;
    for (const f of files) {
      if (await probe(f)) {
        skipped++;
        console.log(`migrate: skip      ${f} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(opts.dir, f), 'utf8');
      process.stdout.write(`migrate: applying  ${f} ... `);
      try {
        // One Query message = one implicit transaction: the file applies
        // atomically together with its schema_migrations row.
        await conn.query(
          `BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`,
        );
        applied++;
        console.log('ok');
      } catch (e) {
        console.log('FAILED');
        if (e instanceof PgError) {
          console.error(`migrate: ERROR ${e.code} in ${f}: ${e.message}${e.position ? ` (position ${e.position})` : ''}`);
        } else {
          console.error(`migrate: ${e.message}`);
        }
        process.exit(1);
      }
    }
    console.log(`migrate: done — ${applied} applied, ${skipped} skipped, ${files.length} total`);
    process.exit(0);
  } finally {
    await conn.end();
  }
}

main();

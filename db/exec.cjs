#!/usr/bin/env node
'use strict';
/**
 * db/exec.cjs — psql-shaped CLI over db/pgclient.cjs (stdlib only, no psql in
 * $HOME/tools/pgsql). Runs one SQL file or one SQL string in a SINGLE Query
 * message, which PostgreSQL wraps in one implicit transaction — so each
 * invocation is atomic.
 *
 * Usage:
 *   node db/exec.cjs [--host H] [--port P] [--user U] [--db D]
 *                   (--file path/to.sql | --sql "SELECT 1") [--echo]
 *
 * Exit codes: 0 = every statement succeeded; 1 = PostgreSQL reported an error
 * (printed to stderr as `ERROR <SQLSTATE>: <message>`); 2 = usage/connectivity
 * failure. On success with --echo, CommandComplete tags are printed.
 */

const fs = require('fs');
const { connect, PgError } = require('./pgclient.cjs');

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 5432 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--host':
        out.host = next();
        break;
      case '--port':
        out.port = Number(next());
        break;
      case '--user':
        out.user = next();
        break;
      case '--db':
        out.database = next();
        break;
      case '--file':
        out.file = next();
        break;
      case '--sql':
        out.sql = next();
        break;
      case '--echo':
        out.echo = true;
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (!out.file && !out.sql) throw new Error('one of --file or --sql is required');
  if (out.file && out.sql) throw new Error('--file and --sql are mutually exclusive');
  return out;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(`usage: node db/exec.cjs [--host H] [--port P] [--user U] [--db D] (--file F | --sql S) [--echo]\n${e.message}`);
    process.exit(2);
  }
  if (process.env.PGHOST) opts.host = process.env.PGHOST;
  if (process.env.PGPORT) opts.port = Number(process.env.PGPORT);
  if (process.env.PGUSER) opts.user = process.env.PGUSER;
  if (process.env.PGDATABASE) opts.database = process.env.PGDATABASE;

  const sql = opts.file ? fs.readFileSync(opts.file, 'utf8') : opts.sql;
  let conn;
  try {
    conn = await connect(opts);
  } catch (e) {
    console.error(`CONNECT-FAILED ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${e.message}`);
    process.exit(2);
  }
  try {
    const { tags, notices } = await conn.query(sql);
    for (const n of notices) console.error(`NOTICE: ${n}`);
    if (opts.echo && tags.length) console.log(tags.join('\n'));
    process.exit(0);
  } catch (e) {
    if (e instanceof PgError) {
      console.error(`ERROR ${e.code}: ${e.message}${e.position ? ` (position ${e.position})` : ''}`);
    } else {
      console.error(`ERROR: ${e.message}`);
    }
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();

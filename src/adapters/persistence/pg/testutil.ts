/**
 * Test bootstrap for the PG persistence adapters (issue #73) — the ONLY
 * module here that knows how a test obtains a PostgreSQL database.
 *
 * Contract (mirrors the Go lanes' test-main discipline):
 *   - the cluster comes from `FUATILIA_TEST_DATABASE_URL`
 *     (default: the lane cluster `postgres://postgres@127.0.0.1:5435/
 *     fuatilia_pgadapters_test`);
 *   - migrations from `db/migrations/` are applied through the SUITE'S OWN
 *     runner (`db/migrate.cjs` — idempotent, one transaction per file),
 *     serialized by a PostgreSQL advisory lock so concurrent vitest workers
 *     cannot race the DDL;
 *   - an UNREACHABLE cluster fails the run — never a silent skip (a green
 *     suite against a database that was not there would be a lie);
 *   - every spec isolates its data by org: aggregates carry fresh UUID org
 *     ids, and `purgeOrgs()` removes a test's rows in FK-safe order.
 *
 * No credentials are hardcoded: the default URL targets the documented
 * TRUST-auth lane cluster (db/pgclient.cjs speaks trust by design); real
 * deployments configure `FUATILIA_PG_*` (see the README).
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import type { PGClientConfig } from './client';

const execFileAsync = promisify(execFile);

/** Environment variable carrying the test cluster URL. */
export const TEST_DATABASE_URL_ENV = 'FUATILIA_TEST_DATABASE_URL';

/** The lane cluster this issue's specs run against (TRUST-auth, port 5435). */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test';

/** The suite's migration runner (dispatcher-owned; invoked, never edited). */
const MIGRATE_SCRIPT = path.resolve(process.cwd(), 'db', 'migrate.cjs');

/** Advisory-lock key serializing migration application across vitest workers. */
const BOOTSTRAP_LOCK_KEY = 'fuatilia-pgadapters-testutil-bootstrap';

/** Parse a postgres:// URL into the client config's connection fields.
 *  Hand-rolled (no global URL): the persistence lane's ambient node surface
 *  is minimal by design (see ../node-runtime.d.ts) and the shape of a
 *  postgres connection string is fully specified — scheme://[user[:pass]@]host[:port]/db.
 */
export const configFromUrl = (url: string): Partial<PGClientConfig> => {
  const match = /^postgres(?:ql)?:\/\/([^@/]*@)?([^/?#]+)(?:\/([^?#]*))?(\?.*)?$/.exec(url);
  if (match === null) {
    throw new Error(`${TEST_DATABASE_URL_ENV} is not a postgres:// URL`);
  }
  const [, userInfo = '', rawHostPort = '', rawDatabase = ''] = match;
  const database = decodeURIComponent(rawDatabase);
  if (database === '') throw new Error(`${TEST_DATABASE_URL_ENV} carries no database name`);
  const at = userInfo.lastIndexOf('@');
  const credentials = at >= 0 ? userInfo.slice(0, at) : '';
  const colon = credentials.indexOf(':');
  const user = colon >= 0 ? credentials.slice(0, colon) : credentials;
  const password = colon >= 0 ? decodeURIComponent(credentials.slice(colon + 1)) : '';
  const hostPort = rawHostPort;
  const hostSplit = hostPort.lastIndexOf(':');
  const host = hostSplit > 0 ? hostPort.slice(0, hostSplit) : hostPort;
  const port = hostSplit > 0 ? Number(hostPort.slice(hostSplit + 1)) : NaN;
  return {
    host: host === '' ? '127.0.0.1' : host,
    port: Number.isFinite(port) && port > 0 ? port : 5432,
    database,
    user: user === '' ? 'postgres' : user,
    password: password === '' ? null : password,
  };
};

/** The URL the specs run against — env override wins, default is the lane cluster. */
export const testDatabaseUrl = (): string => {
  const fromEnv = process.env[TEST_DATABASE_URL_ENV];
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_TEST_DATABASE_URL;
};

/**
 * Prove the cluster is reachable; an unreachable PostgreSQL is a HARD
 * failure (the specs' value comes from real durability semantics — a skip
 * would silently zero out this lane's guarantees).
 */
export const assertClusterReachable = async (url: string): Promise<void> => {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const server = await client.query('select version()');
    if (!/PostgreSQL 1[6-9]\./.test(String(server.rows[0]?.version ?? ''))) {
      throw new Error(`fuatilia requires PostgreSQL 16+; server reported: ${String(server.rows[0]?.version ?? 'unknown')}`);
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PostgreSQL test cluster unreachable at ${hostOf(url)} — start the 16.4 lane cluster ` +
      `(FUATILIA_TEST_DATABASE_URL, default ${DEFAULT_TEST_DATABASE_URL}) and re-run; ` +
      `the PG persistence specs never skip silently. Driver error: ${detail}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Apply `db/migrations/*.sql` through `db/migrate.cjs` (the suite's own
 * forward-only runner — idempotent, one transaction per file). A PostgreSQL
 * advisory lock serializes concurrent vitest workers; the runner's own
 * `schema_migrations` ledger makes repeats a no-op.
 */
export const ensureMigrated = async (url: string): Promise<void> => {
  await access(MIGRATE_SCRIPT); // throws a clear ENOENT if the cwd is not the repo root
  const lockClient = new Client({ connectionString: url });
  try {
    await lockClient.connect();
    await lockClient.query('select pg_advisory_lock(hashtextextended($1, 0))', [BOOTSTRAP_LOCK_KEY]);
    const config = configFromUrl(url);
    const { stderr } = await execFileAsync(
      process.execPath,
      [MIGRATE_SCRIPT],
      {
        env: {
          ...process.env,
          PGHOST: config.host ?? '127.0.0.1',
          PGPORT: String(config.port ?? 5432),
          PGUSER: config.user ?? 'postgres',
          PGPASSWORD: config.password ?? '',
          PGDATABASE: config.database ?? 'fuatilia',
        },
      },
    );
    if (stderr.trim() !== '') throw new Error(`db/migrate.cjs reported errors: ${stderr.trim()}`);
  } finally {
    await lockClient.query('select pg_advisory_unlock(hashtextextended($1, 0))', [BOOTSTRAP_LOCK_KEY]).catch(() => undefined);
    await lockClient.end().catch(() => undefined);
  }
};

/**
 * One-call spec bootstrap: reachability + migrations. Returns the connection
 * config the specs hand to `new PGClient({ config })`.
 */
export const bootstrapTestDb = async (): Promise<Partial<PGClientConfig>> => {
  const url = testDatabaseUrl();
  await assertClusterReachable(url);
  await ensureMigrated(url);
  return configFromUrl(url);
};

/**
 * Remove every lane row of the given orgs, in FK-safe order (children before
 * parents). Test hygiene only — production code never deletes (R3); the
 * anchors and audit rows a test created go with its orgs. Rows of OTHER
 * orgs (concurrent workers, other lanes) are never touched.
 */
export const purgeOrgs = async (url: string, orgIds: readonly string[]): Promise<void> => {
  if (orgIds.length === 0) return;
  const client = new Client({ connectionString: url });
  const placeholders = orgIds.map((_, index) => `$${index + 1}::uuid`).join(', ');
  try {
    await client.connect();
    await client.query('BEGIN');
    for (const statement of PURGE_STATEMENTS) {
      await client.query(`DELETE FROM ${statement} WHERE org_id IN (${placeholders})`, [...orgIds]);
    }
    // The org anchor rows root the FK graph — delete them last, by id.
    await client.query(`DELETE FROM orgs WHERE id IN (${placeholders})`, [...orgIds]);
    await client.query('COMMIT');
  } finally {
    await client.end().catch(() => undefined);
  }
};

/** FK-safe purge order (children first; orgs last, handled separately).
 *  `fuatilia_lane_quarantine` is deliberately NOT purged: quarantine rows are
 *  forensic records, not org-owned state — they are left for inspection. */
const PURGE_STATEMENTS: readonly string[] = [
  'fuatilia_lane_events',
  'fuatilia_case_lane_state',
  'case_actions',
  'collections_case_receivables',
  'collections_cases',
  'case_sequences',
  'allocations',
  'refunds',
  'payments',
  'receivables',
  'invoice_items',
  'invoices',
  'audit_events',
  'api_keys',
  'sessions',
  'fuatilia_lane_grants',
  'role_assignments',
  'roles',
  'users',
];

/** Host/database for a refusal message — the URL itself (with credentials) never echoes. */
const hostOf = (url: string): string => {
  try {
    const config = configFromUrl(url);
    return `${config.user ?? 'postgres'}@${config.host ?? '127.0.0.1'}:${config.port ?? 5432}/${config.database ?? ''}`;
  } catch {
    return '(unparseable URL)';
  }
};

// --- the ephemeral cluster (down/up + crash tests) -----------------------------------
//
// The shared lane cluster must stay up for every other spec, so the specs
// that need PostgreSQL to actually GO AWAY (sticky failure under a dead
// server, a flush killed mid-transaction) run against a THROWAWAY cluster
// spawned into a temp directory: real initdb, real pg_ctl stop/start, real
// crash recovery — the issue's own Testing prescription. Binaries come from
// `FUATILIA_PG_BIN_DIR` (the workspace's portable 16.4 install by default);
// missing binaries are a HARD failure, never a skip.

/** Directory holding the portable PostgreSQL 16 binaries (initdb/pg_ctl). */
export const PG_BIN_DIR_ENV = 'FUATILIA_PG_BIN_DIR';
export const DEFAULT_PG_BIN_DIR = '/home/z/my-project/tools/pg164/bin';

/** A disposable PostgreSQL cluster: start it, migrate it, stop it, crash it. */
export interface EphemeralCluster {
  /** postgres:// URL of the cluster's only database (created at spawn). */
  readonly url: string;
  /** The connection fields, ready for `new PGClient({ config })`. */
  readonly config: Partial<PGClientConfig>;
  /** Start (or restart after a stop — crash recovery included). */
  start(): Promise<void>;
  /** Stop the postmaster. mode 'fast' = clean shutdown; 'immediate' = crash. */
  stop(mode?: 'fast' | 'immediate'): Promise<void>;
  /** Stop (if still running) and delete the data directory. */
  destroy(): Promise<void>;
}

const binPath = (binDir: string, name: string): string => path.join(binDir, name);

const runBin = async (binDir: string, name: string, args: readonly string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(binPath(binDir, name), [...args]);
    return stdout;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${name} ${args.join(' ')} failed — the ephemeral-cluster specs never skip silently. ${detail}`,
    );
  }
};

/** Grab a TCP port that is free RIGHT NOW (best effort — a tiny race is fine). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });

/**
 * initdb a fresh cluster in a temp dir, start it on a free port (trust
 * auth, TCP only), create one database. The cluster is PRIVATE to the
 * calling spec file — it may be stopped, crashed and restarted at will.
 */
export const spawnEphemeralCluster = async (label: string): Promise<EphemeralCluster> => {
  const binDir = process.env[PG_BIN_DIR_ENV]?.trim() || DEFAULT_PG_BIN_DIR;
  await access(binPath(binDir, 'initdb'));
  await access(binPath(binDir, 'pg_ctl'));

  const dataDir = await mkdtemp(path.join(tmpdir(), `fuatilia-pg-${label}-`));
  const socketDir = path.join(dataDir, 'socket');
  await runBin(binDir, 'initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-instructions']);

  const port = await freePort();
  const database = `fuatilia_${label.replace(/[^a-z0-9]/gi, '_')}_test`;
  let running = false;

  const start = async (): Promise<void> => {
    await runBin(binDir, 'pg_ctl', [
      '-D', dataDir, '-w', '-t', '30', '-l', path.join(dataDir, 'pg.log'), 'start',
      '-o', `-p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1`,
    ]);
    running = true;
  };

  const stop = async (mode: 'fast' | 'immediate' = 'fast'): Promise<void> => {
    if (!running) return;
    await runBin(binDir, 'pg_ctl', ['-D', dataDir, '-w', '-t', '30', '-m', mode, 'stop']);
    running = false;
  };

  await start();

  // Wait for TCP readiness (pg_ctl -w polls its local socket; the specs use TCP).
  const url = `postgres://postgres@127.0.0.1:${port}/${database}`;
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    const probe = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
    try {
      await probe.connect();
      ready = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await probe.end().catch(() => undefined);
    }
  }
  if (!ready) {
    await stop('immediate').catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(`ephemeral cluster never became ready on port ${port} — the specs never skip silently`);
  }

  // CREATE DATABASE is not idempotent — check first (a restarted cluster keeps it).
  const admin = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
  try {
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${database}`); // the name is sanitized [a-z0-9_] above
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const config = configFromUrl(url);
  return {
    url,
    config,
    start,
    stop,
    destroy: async (): Promise<void> => {
      await stop(running ? 'fast' : 'immediate').catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
};

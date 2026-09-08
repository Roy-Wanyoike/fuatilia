/**
 * The thin async PostgreSQL client the PG persistence adapters share
 * (issue #73): an env-driven wrapper over the pre-seeded `pg` Pool.
 *
 * Responsibilities — deliberately narrow:
 *   - config from `FUATILIA_PG_*` environment variables (or explicit
 *     options, which win) — see PG_CLIENT_ENV below and the README;
 *   - parameterized SQL ONLY: every statement goes through `query(name,
 *     text, values)` with a stable statement NAME, which is also what the
 *     slow-query logger reports (duration + statement name, never values);
 *   - transaction helper (`withTx`) — every multi-statement mutation the
 *     stores run is all-or-nothing (the crash/partial-failure guarantee);
 *   - least-privilege note: the role this client logs in as needs SELECT/
 *     INSERT/UPDATE/USAGE on the lane's tables and sequences ONLY — no
 *     superuser, no CREATE outside the adapter's own idempotent lane DDL
 *     (see README "Running with least privilege");
 *   - error scrubbing: failures surface as typed `PGStoreError` values
 *     carrying the SQLSTATE, constraint, table and statement name — never a
 *     connection string, a password, or a credential echo.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { LANE_SCHEMA_DDL } from './schema-map';

/** Env vars the client reads when options don't override them. */
export const PG_CLIENT_ENV = {
  host: 'FUATILIA_PG_HOST',
  port: 'FUATILIA_PG_PORT',
  database: 'FUATILIA_PG_DATABASE',
  user: 'FUATILIA_PG_USER',
  password: 'FUATILIA_PG_PASSWORD',
  ssl: 'FUATILIA_PG_SSL',
  maxPool: 'FUATILIA_PG_MAX_POOL',
  slowQueryMs: 'FUATILIA_PG_SLOW_QUERY_MS',
} as const;

/** SSL mode the `FUATILIA_PG_SSL` variable accepts. */
export type PgSslMode = 'disable' | 'require';

export interface PGClientConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Never logged, never echoed into errors. */
  readonly password: string | null;
  readonly ssl: PgSslMode;
  readonly maxPool: number;
  /** Statements slower than this are reported through the logger. */
  readonly slowQueryMs: number;
}

/** Read the FUATILIA_PG_* environment into a config (defaults for local dev). */
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): PGClientConfig => ({
  host: env[PG_CLIENT_ENV.host] ?? '127.0.0.1',
  port: Number(env[PG_CLIENT_ENV.port] ?? 5432),
  database: env[PG_CLIENT_ENV.database] ?? 'fuatilia',
  user: env[PG_CLIENT_ENV.user] ?? 'fuatilia',
  password: env[PG_CLIENT_ENV.password] ?? null,
  ssl: env[PG_CLIENT_ENV.ssl] === 'require' ? 'require' : 'disable',
  maxPool: Math.max(1, Number(env[PG_CLIENT_ENV.maxPool] ?? 10)),
  slowQueryMs: Math.max(0, Number(env[PG_CLIENT_ENV.slowQueryMs] ?? 250)),
});

/** The observability sink (injectable; default console). Never receives values. */
export interface PGLogger {
  warn(message: string): void;
  error(message: string): void;
}

const consoleLogger: PGLogger = {
  warn: (message) => console.warn(`[pg-store] ${message}`),
  error: (message) => console.error(`[pg-store] ${message}`),
};

/**
 * The typed failure every adapter surfaces. Fields are the scrubbed subset
 * of a PostgreSQL error: SQLSTATE, constraint, table, statement NAME. The
 * raw server message is kept (PostgreSQL never puts credentials in error
 * messages); server DETAIL is dropped — that is the field that can echo row
 * values, and the constraint name already says what tripped.
 */
export class PGStoreError extends Error {
  readonly sqlstate: string;
  readonly constraint: string | null;
  readonly table: string | null;
  readonly statement: string;
  readonly code:
    | 'PG_CONNECTION_FAILED'
    | 'PG_UNIQUE_VIOLATION'
    | 'PG_FOREIGN_KEY_VIOLATION'
    | 'PG_CHECK_VIOLATION'
    | 'PG_QUERY_FAILED';

  constructor(init: {
    readonly code: PGStoreError['code'];
    readonly sqlstate: string;
    readonly constraint: string | null;
    readonly table: string | null;
    readonly statement: string;
    readonly message: string;
  }) {
    super(`pg store failure in '${init.statement}': ${init.code} ${init.sqlstate}${init.constraint ? ` (${init.constraint})` : ''} — ${init.message}`);
    this.name = 'PGStoreError';
    this.code = init.code;
    this.sqlstate = init.sqlstate;
    this.constraint = init.constraint;
    this.table = init.table;
    this.statement = init.statement;
  }
}

interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly detail?: string;
  readonly message?: string;
}

const asPgError = (error: unknown): PgErrorLike | null =>
  typeof error === 'object' && error !== null && 'code' in error ? (error as PgErrorLike) : null;

const SQLSTATE_CLASS = {
  connection: '08',
  unique: '23505',
  foreignKey: '23503',
  check: '23514',
} as const;

/**
 * Node network-failure codes a dead/unreachable server produces BEFORE any
 * SQLSTATE exists (ECONNREFUSED et al. are not PostgreSQL errors — the driver
 * surfaces the raw system error). They are connection failures, honestly
 * classified, with a synthetic SQLSTATE from the 08 (connection exception)
 * class. None of these messages can carry credentials.
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
]);

export const isUniqueViolation = (error: unknown): boolean =>
  asPgError(error)?.code === SQLSTATE_CLASS.unique;
export const isForeignKeyViolation = (error: unknown): boolean =>
  asPgError(error)?.code === SQLSTATE_CLASS.foreignKey;

/** Map a raw driver/server error into the scrubbed, typed store error. */
export const toStoreError = (error: unknown, statement: string): PGStoreError => {
  const pg = asPgError(error);
  const rawCode = typeof pg?.code === 'string' ? pg.code : null;
  let code: PGStoreError['code'] = 'PG_QUERY_FAILED';
  let sqlstate = rawCode ?? 'XX000';
  if (rawCode !== null && NETWORK_ERROR_CODES.has(rawCode)) {
    code = 'PG_CONNECTION_FAILED';
    sqlstate = '08001';
  } else if (rawCode?.startsWith(SQLSTATE_CLASS.connection)) code = 'PG_CONNECTION_FAILED';
  else if (rawCode === SQLSTATE_CLASS.unique) code = 'PG_UNIQUE_VIOLATION';
  else if (rawCode === SQLSTATE_CLASS.foreignKey) code = 'PG_FOREIGN_KEY_VIOLATION';
  else if (rawCode === SQLSTATE_CLASS.check) code = 'PG_CHECK_VIOLATION';
  return new PGStoreError({
    code,
    sqlstate,
    constraint: typeof pg?.constraint === 'string' ? pg.constraint : null,
    table: typeof pg?.table === 'string' ? pg.table : null,
    statement,
    message: typeof pg?.message === 'string' && pg.message !== '' ? pg.message : String(error),
  });
};

export interface PGClientOptions {
  /** Explicit config — wins over the FUATILIA_PG_* environment. */
  readonly config?: Partial<PGClientConfig>;
  /** Pre-built pool (tests inject one; ownership transfers to the client). */
  readonly pool?: Pool;
  readonly logger?: PGLogger;
}

/**
 * The shared client. Constructing it does NOT connect (the pool connects
 * lazily); `ensureLaneSchema()` at store boot runs the adapter's idempotent
 * DDL, and `close()` ends the pool it owns.
 */
export class PGClient {
  readonly config: PGClientConfig;
  private readonly pool: Pool;
  private readonly logger: PGLogger;
  private closed = false;
  private laneSchema: Promise<void> | null = null;

  constructor(options: PGClientOptions = {}) {
    const env = configFromEnv();
    this.config = { ...env, ...(options.config ?? {}) };
    this.logger = options.logger ?? consoleLogger;
    this.pool =
      options.pool ??
      new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password ?? undefined,
        max: this.config.maxPool,
        // Bounded waits are a correctness requirement, not a nicety: a request
        // path must never hang forever on a stuck connection or a lost query —
        // it must fail with an honest, typed error instead.
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
        ssl: this.config.ssl === 'require' ? { rejectUnauthorized: false } : undefined,
        application_name: 'fuatilia-pg-store',
      });
    this.pool.on('error', (error: unknown) => {
      // An idle-client failure must not crash the process (fail-closed at
      // the call sites — the next query surfaces a PG_CONNECTION_FAILED).
      this.logger.error(`idle client error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Run one named, parameterized statement. `name` travels to the server as
   * the prepared-statement name and is the ONLY identifier the slow-query
   * logger reports — statement VALUES never reach the logger.
   */
  async query(name: string, text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    this.assertOpen();
    const started = performance.now();
    try {
      const result = await this.pool.query({ text, values: [...values] });
      this.reportSlow(name, started);
      return result;
    } catch (error: unknown) {
      throw toStoreError(error, name);
    }
  }

  /**
   * Run `fn` inside ONE transaction on ONE pooled client. The callback
   * receives a tx-scoped `query` with the same naming discipline. Any throw
   * (including a client disconnect mid-transaction) rolls the transaction
   * back — the server discards an uncommitted transaction when the session
   * dies, so a crashed save leaves ZERO partial aggregates.
   */
  async withTx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
    this.assertOpen();
    const client = await this.pool.connect().catch((error: unknown) => {
      throw toStoreError(error, 'connect');
    });
    const started = performance.now();
    try {
      await client.query('BEGIN');
      const tx: TxHandle = {
        query: async (name, text, values = []) => {
          const txStarted = performance.now();
          try {
            const result = await client.query({ text, values: [...values] });
            this.reportSlow(name, txStarted);
            return result;
          } catch (error: unknown) {
            throw toStoreError(error, name);
          }
        },
      };
      const outcome = await fn(tx);
      await client.query('COMMIT');
      this.reportSlow('tx', started);
      return outcome;
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined); // the rollback of a dead session is a no-op
      throw error instanceof PGStoreError ? error : toStoreError(error, 'tx');
    } finally {
      client.release();
    }
  }

  /**
   * The adapter's idempotent lane DDL (adapter-owned tables only — the
   * platform migrations are NOT the adapter's business here). Runs at most
   * once per client; concurrent callers await the same promise. Each DDL
   * statement gets its own prepared-statement NAME — names must be unique
   * per text on a connection (the driver refuses a name reused over
   * different SQL).
   */
  ensureLaneSchema(): Promise<void> {
    if (this.laneSchema === null) {
      this.laneSchema = (async () => {
        for (const [index, ddl] of LANE_SCHEMA_DDL.entries()) {
          await this.query(`pg_store.ensure_lane_schema.${index + 1}`, ddl);
        }
      })();
    }
    return this.laneSchema;
  }

  /** Drain and end the owned pool (idempotent). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.laneSchema !== null) await this.laneSchema.catch(() => undefined);
    await this.pool.end();
  }

  /** A raw pooled client for tests that must simulate a crashed session. */
  async connectForCrashTest(): Promise<PoolClient> {
    return this.pool.connect();
  }

  private assertOpen(): void {
    if (this.closed) throw new PGStoreError({
      code: 'PG_CONNECTION_FAILED',
      sqlstate: '08003',
      constraint: null,
      table: null,
      statement: 'client',
      message: 'the PGClient is closed',
    });
  }

  private reportSlow(statement: string, started: number): void {
    const durationMs = performance.now() - started;
    if (durationMs >= this.config.slowQueryMs) {
      // Statement NAME + duration + row count only — never values.
      this.logger.warn(
        `slow query ${statement} took ${durationMs.toFixed(1)}ms (threshold ${this.config.slowQueryMs}ms)`,
      );
    }
  }
}

/** The tx-scoped query handle `withTx` hands to its callback. */
export interface TxHandle {
  query<R extends QueryResultRow = QueryResultRow>(
    name: string,
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export { SQLSTATE_CLASS };

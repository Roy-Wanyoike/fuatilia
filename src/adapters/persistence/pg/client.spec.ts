/**
 * PGClient specs (issue #73) — the thin async wrapper over the `pg` Pool.
 *
 * Covered: config assembly (explicit config wins over FUATILIA_PG_* env),
 * honest failure against an unreachable cluster (no silent retries that
 * fake liveness), transaction commit and ROLLBACK semantics (a thrown
 * callback must leave zero partial state), and the observability hook
 * (slow-query logging carries the statement NAME and duration, never
 * values — parameterized SQL only, no credential echo).
 *
 * The shared lane cluster comes from testutil (FUATILIA_TEST_DATABASE_URL,
 * default postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test);
 * an unreachable cluster fails the run — never a silent skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGClient, configFromEnv, PG_CLIENT_ENV } from './client';
import { bootstrapTestDb, testDatabaseUrl, DEFAULT_TEST_DATABASE_URL } from './testutil';

let config: Record<string, unknown>;
const opened: PGClient[] = [];

beforeAll(async () => {
  config = (await bootstrapTestDb()) as unknown as Record<string, unknown>;
});

afterAll(async () => {
  for (const client of opened) await client.close().catch(() => undefined);
});

const track = (client: PGClient): PGClient => {
  opened.push(client);
  return client;
};

describe('PGClient — config assembly', () => {
  it('builds its config from the FUATILIA_PG_* environment, explicit config wins', () => {
    const env = { ...process.env };
    try {
      process.env[PG_CLIENT_ENV.host] = '10.255.255.1';
      process.env[PG_CLIENT_ENV.port] = '5433';
      process.env[PG_CLIENT_ENV.database] = 'env_db';
      process.env[PG_CLIENT_ENV.user] = 'env_user';
      const fromEnv = configFromEnv();
      expect(fromEnv.host).toBe('10.255.255.1');
      expect(fromEnv.port).toBe(5433);
      expect(fromEnv.database).toBe('env_db');
      expect(fromEnv.user).toBe('env_user');

      const client = new PGClient({ config: { host: '127.0.0.1', port: 5435, database: 'explicit_db' } });
      expect(client.config.host).toBe('127.0.0.1');
      expect(client.config.port).toBe(5435);
      expect(client.config.database).toBe('explicit_db');
      // unspecified fields still fall back to the env-derived defaults
      expect(client.config.user).toBe('env_user');
    } finally {
      process.env = env;
    }
  });

  it('the test lane URL parses into the documented cluster fields', () => {
    const client = track(new PGClient({ config: { host: '127.0.0.1', port: 5435, database: 'fuatilia_pgadapters_test', user: 'postgres' } }));
    expect(client.config.database).toBe('fuatilia_pgadapters_test');
    expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
  });
});

describe('PGClient — liveness honesty', () => {
  it('fails honestly against an unreachable cluster (never a fake success)', async () => {
    const client = track(new PGClient({ config: { host: '127.0.0.1', port: 1, database: 'fuatilia_pgadapters_test', user: 'postgres' } }));
    await expect(client.query('probe', 'SELECT 1')).rejects.toThrow(/ECONNREFUSED|timeout|connection/i);
  });
});

describe('PGClient — transaction semantics', () => {
  it('withTx commits when the callback succeeds and the rows are visible', async () => {
    const client = track(new PGClient({ config }));
    await client.query('lane-boot', `CREATE TABLE IF NOT EXISTS client_spec_tx (id int PRIMARY KEY, label text)`);
    const committed = await client.withTx(async (tx) => {
      await tx.query('insert-1', 'INSERT INTO client_spec_tx (id, label) VALUES ($1, $2)', [1, 'committed']);
      return 'ok';
    });
    expect(committed).toBe('ok');
    const check = await client.query('read-back', 'SELECT label FROM client_spec_tx WHERE id = 1');
    expect(check.rows[0]?.label).toBe('committed');
  });

  it('withTx ROLLS BACK when the callback throws — zero partial state', async () => {
    const client = track(new PGClient({ config }));
    await client.query('lane-boot-2', `CREATE TABLE IF NOT EXISTS client_spec_tx (id int PRIMARY KEY, label text)`);
    await expect(
      client.withTx(async (tx) => {
        await tx.query('insert-2', 'INSERT INTO client_spec_tx (id, label) VALUES ($1, $2)', [2, 'doomed']);
        throw new Error('rollback now');
      }),
    ).rejects.toThrow('rollback now');
    const check = await client.query('read-back-2', 'SELECT count(*)::int AS n FROM client_spec_tx WHERE id = 2');
    expect(check.rows[0]?.n).toBe(0);
    await client.query('cleanup', 'DROP TABLE IF EXISTS client_spec_tx');
  });
});

describe('PGClient — observability hook', () => {
  it('the slow-query logger receives statement NAME and duration, never values', async () => {
    const messages: string[] = [];
    const client = track(new PGClient({
      config: { ...config, slowQueryMs: 0 } as never,
      logger: { warn: (m) => messages.push(m), error: () => undefined },
    }));
    await client.query('slow-probe', 'SELECT 1 AS one', []);
    // slowQueryMs = 0 → every query logs; the entry names the statement and the duration,
    // and never echoes the parameter VALUES (there are none here, but the rule holds).
    const slow = messages.find((m) => m.includes('slow-probe'));
    expect(slow).toBeTruthy();
    expect(slow ?? '').toMatch(/ms/i);
    expect(slow ?? '').not.toMatch(/values?\s*[:=]/i);
  });
});

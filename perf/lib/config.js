'use strict';
/**
 * perf/lib/config.js — environment-driven configuration for the k6 harness
 * (issue #147). NO defaults carry credentials: the only credential-ish values
 * are the LOCAL FIXTURE api-key id/secret that perf/seed/seed_perf.cjs prints
 * after seeding — they authenticate nothing outside a localhost trust-auth
 * database and must never be pointed at a real deployment.
 *
 * Pure ES modules (k6-native). Env access goes through __ENV only.
 *
 * k6 v2 NOTE: the runtime no longer forwards host environment variables into
 * __ENV — every knob below must be passed explicitly, e.g.
 *   k6 run -e PERF_API_KEY_ID=… -e PERF_API_KEY_SECRET=… perf/scenarios/reads.js
 */

const env = typeof __ENV !== 'undefined' ? __ENV : {};

function required(name) {
  const v = env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `perf: ${name} is required — pass it explicitly (k6 v2 does not forward host env): ` +
      `k6 run -e ${name}=… — credentials are printed by perf/seed/seed_perf.cjs`,
    );
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function int(name, fallback) {
  const v = optional(name, '');
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`perf: ${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return Math.floor(n);
}

export const config = {
  // --- target ----------------------------------------------------------------
  // Compose stack:  http://127.0.0.1:8080  (make up → api publishes 8080)
  // Local Go lane:  http://127.0.0.1:8080  (LISTEN_ADDR=127.0.0.1:8080)
  baseUrl: optional('PERF_BASE_URL', 'http://127.0.0.1:8080'),

  // --- credentials (fixture-only — see the header note) ----------------------
  apiKeyId: required('PERF_API_KEY_ID'),
  apiKeySecret: required('PERF_API_KEY_SECRET'),

  // --- fixture shape (perf/seed/seed_perf.cjs prints these too) ---------------
  orgSlug: optional('PERF_ORG_SLUG', 'perf-main'),

  // --- request shape -----------------------------------------------------------
  // Page size for list endpoints (contract bound: 1–100, kernel never clamps).
  pageSize: int('PERF_PAGE_SIZE', 50),
  // How many pages a single list walk follows before stopping (bounds the tail).
  maxListPages: int('PERF_MAX_LIST_PAGES', 3),

  // --- scenario sizing (override via env without editing the scripts) ----------
  reads: {
    vus: int('PERF_READS_VUS', 10),
    duration: optional('PERF_READS_DURATION', '2m'),
  },
  paymentsWrite: {
    vus: int('PERF_WRITE_VUS', 5),
    duration: optional('PERF_WRITE_DURATION', '1m'),
  },
  // Timeouts: abort slow requests so p95 measures the served surface, not a hang.
  timeout: optional('PERF_TIMEOUT', '10s'),
};

/** Authorization header value — `ApiKey <id>.<secret>` split at the FIRST dot. */
export const authorization = `ApiKey ${config.apiKeyId}.${config.apiKeySecret}`;

export default config;

'use strict';
/**
 * perf/lib/thresholds.js — the single source of k6 threshold truth (issue #147).
 *
 * EVERY scenario file imports and spreads `slo.thresholds` from here so the
 * SLO mapping can never drift between scenarios. Edit thresholds ONLY here.
 *
 * ── Where the numbers come from (read this before touching them) ────────────
 *
 * The roadmap's SLO *language* (docs/PRODUCT_ROADMAP.md, P0/P1 "Observability
 * requirements" + docs/SPEC.md §59 "Monitor" / §67 "Platform health metrics")
 * names the quantities the platform must keep honest: API latency, error
 * rates, payment success rate, webhook processing latency, API uptime.
 *
 * It deliberately sets NO numeric targets yet — docs/PRODUCTION_AUDIT.md
 * §"Production traffic characteristics": "no deployment exists to measure;
 * the SPEC sets no numeric SLOs". Fabricating "roadmap numbers" would be a
 * lie, so every number below is a HARNESS-PROPOSED default, chosen to be
 * achievable by the as-shipped default stack (single Go api process, pgxpool
 * 10 conns, local PostgreSQL 16) and flagged `proposed: true`. They become
 * the SLOs only when product ratifies them; the k6 exit code is wired to
 * them either way so a run FAILS LOUDLY instead of silently drifting.
 *
 * Probe → SLO-language mapping:
 *   http_req_failed                      → "Error rates"            (SPEC §59)
 *   http_req_duration (reads mix)        → "API latency"            (SPEC §59)
 *   http_req_duration (payments write)   → "Webhook processing
 *                                          latency"                 (SPEC §67)
 *                                          — /v1/payments/intake and
 *                                          /confirmations ARE the Daraja
 *                                          callback surface (webhook-ish
 *                                          POSTs), so their p95 doubles as
 *                                          the webhook-latency probe.
 *   checks rate                          → "Payment success rate"   (SPEC §59/§67)
 *                                          on the intake→confirm path.
 */

/** @type {Record<string, number>} proposed p95 ceilings in milliseconds */
const P95 = {
  reads: 300,        // authed list/get mix — "API latency"
  paymentsWrite: 400, // intake + confirm — "webhook processing latency" (Daraja callback path)
  smoke: 1000,       // sanity only — never a real SLO
};

/** @type {number} max fraction of requests allowed to fail (HTTP error or exception) */
const ERROR_RATE = 0.01; // "Error rates" — 99% request success floor

/** @type {number} min fraction of envelope/contract checks that must hold */
const CHECK_RATE = 0.99; // "payment success rate" surrogate on the write path

/**
 * The threshold block every scenario spreads into `options.thresholds`.
 * Keys use k6's `tag:value` selector syntax; the `name` tag is attached
 * per-request in lib/helpers.js so thresholds are per-ENDPOINT, not per-URL
 * (path params would otherwise explode cardinality and never match).
 * Syntax note: k6 v2 (the runtime validated here) spells percentiles
 * `p(95)` — the pre-1.0 `p95` spelling no longer parses.
 */
const thresholds = {
  // Global error-rate floor — "Error rates" (SPEC §59).
  'http_req_failed': [`rate<${ERROR_RATE}`],

  // Per-scenario latency SLOs (proposed; see the mapping above).
  [`http_req_duration{scenario:reads}`]: [`p(95)<${P95.reads}`],
  [`http_req_duration{scenario:payments-write}`]: [`p(95)<${P95.paymentsWrite}`],
  [`http_req_duration{scenario:smoke}`]: [`p(95)<${P95.smoke}`],

  // Contract checks (envelope shape, x-request-id, expected status) must
  // essentially never slip — a "fast wrong answer" is still an SLO breach.
  'checks': [`rate>${CHECK_RATE}`],
};

export { thresholds, P95, ERROR_RATE, CHECK_RATE };

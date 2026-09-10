'use strict';
/**
 * perf/lib/options.js — k6 `options` assembly shared by every scenario
 * (issue #147). One place decides executor shape + threshold wiring so the
 * SLO mapping in lib/thresholds.js applies uniformly.
 */

import { config } from './config.js';

/**
 * Build the scenario `options` block for one scenario file.
 *
 * Executor choice: `constant-vus` (closed model) — the harness answers
 * "how does the mounted surface behave at N concurrent consoles/API
 * clients", which is the shape the roadmap's SLO language assumes (latency
 * at a served load level), and it keeps threshold breaches interpretable:
 * p95 moves because the service did, not because arrival jitter did.
 *
 * @param {'smoke'|'reads'|'payments-write'} name  must match the scenario
 *        tag used by the threshold selectors in lib/thresholds.js
 * @param {object} thresholds  the shared threshold block
 * @param {object} [overrides] optional k6 option overrides (used by smoke)
 */
export function scenarioOptions(name, thresholds, overrides = {}) {
  const size =
    name === 'reads' ? config.reads :
    name === 'payments-write' ? config.paymentsWrite :
    { vus: 1, duration: '30s' };

  return {
    scenarios: {
      [name]: {
        executor: 'constant-vus',
        vus: size.vus,
        duration: size.duration,
        tags: { scenario: name },
      },
    },
    thresholds,
    // Keep the summary readable and the metrics small; drop unused system
    // tags, keep the ones the thresholds + triage need.
    systemTags: ['check', 'error', 'error_code', 'expected_response', 'group', 'method', 'name', 'proto', 'scenario', 'status'],
    ...overrides,
  };
}

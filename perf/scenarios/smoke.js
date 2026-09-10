'use strict';
/**
 * perf/scenarios/smoke.js — pre-flight sanity scenario (issue #147).
 *
 * ONE virtual user, a handful of iterations, one pass over each surface
 * family: public (health/meta), authed read, authed write. A run answers
 * "is the target up, migrated, seeded and are the harness credentials
 * valid?" in seconds. It is NOT a load test — its only threshold is a loose
 * latency ceiling so a hung target fails loudly instead of silently.
 *
 * Run:  k6 run perf/scenarios/smoke.js
 */

import { scenarioOptions } from '../lib/options.js';
import { config, authorization } from '../lib/config.js';
import { authedGet, authedPost, expectEnvelope, externalRef } from '../lib/helpers.js';
import { thresholds } from '../lib/thresholds.js';

export const options = scenarioOptions('smoke', thresholds, {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '10s',
      tags: { scenario: 'smoke' },
    },
  },
});

export default function () {
  // 1) public surface — no auth, must always answer.
  expectEnvelope(authedGet('GET /v1/health', '/v1/health'), 200, 'health');
  expectEnvelope(authedGet('GET /v1/meta', '/v1/meta'), 200, 'meta');

  // 2) authed read — proves the fixture api key resolves + a grant covers it.
  expectEnvelope(authedGet('GET /v1/receivables', `/v1/receivables?limit=${Math.min(config.pageSize, 5)}`), 200, 'authed read');

  // 3) authed write — proves intake accepts harness traffic end-to-end.
  //    One payment per smoke iteration: negligible, but real.
  const intake = authedPost('POST /v1/payments/intake', '/v1/payments/intake', {
    channel: 'c2b',
    externalRef: `smoke-${externalRef()}`,
    idempotencyKey: `smoke-${externalRef()}-idem`,
    amount: { minor: 100000, currency: 'KES' },
  });
  const intakeBody = expectEnvelope(intake, 201, 'smoke intake');
  const paymentId = intakeBody && intakeBody.data && intakeBody.data.payment && intakeBody.data.payment.id;
  if (paymentId) {
    expectEnvelope(
      authedPost('POST /v1/payments/{id}/confirmations', `/v1/payments/${paymentId}/confirmations`, {
        amount: { minor: 100000, currency: 'KES' },
      }),
      201,
      'smoke confirm',
    );
  }
}

// The Authorization header is asserted at import time: a missing credential
// must fail the run BEFORE any request goes out, with a actionable message.
if (!authorization.includes('.')) {
  throw new Error('perf: PERF_API_KEY_ID/PERF_API_KEY_SECRET missing — see perf/README.md');
}

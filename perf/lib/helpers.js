'use strict';
/**
 * perf/lib/helpers.js — request + contract-check helpers for the k6 harness
 * (issue #147).
 *
 * Wire rules implemented here (api/openapi/fuatilia.v1.yaml header notes):
 *   - auth is `Authorization: ApiKey <id>.<secret>` (split at the FIRST dot);
 *   - successes are `{ "data": ..., "meta"?: ... }`;
 *   - failures are `{ "error": { "code", "message" }, "requestId" }`;
 *   - every response carries x-request-id.
 *
 * Every request carries a `name` tag (stable per endpoint) so thresholds in
 * lib/thresholds.js can select by endpoint without path-param cardinality,
 * and an x-correlation-id so a run can be traced against the api's logs.
 */

import http from 'k6/http';
import { check } from 'k6';
import { config, authorization } from './config.js';

const BASE = config.baseUrl;
const TIMEOUT = config.timeout;

const baseHeaders = {
  Authorization: authorization,
  'Content-Type': 'application/json',
};

/** Correlation id for this VU+iteration (k6 built-ins; unique per request burst).
 *  setup()/teardown() define __VU but NOT __ITER — guard both so setup-time
 *  list harvests keep a correlation id too. */
function correlationId() {
  const vu = typeof __VU !== 'undefined' ? __VU : 'setup';
  const iter = typeof __ITER !== 'undefined' ? __ITER : '0';
  return `k6-${vu}-${iter}`;
}

/**
 * Authed GET with a stable endpoint name tag.
 * @param {string} name   threshold-stable endpoint name, e.g. "GET /v1/receivables"
 * @param {string} path   path (+query) starting with /v1/
 */
export function authedGet(name, path) {
  return http.get(`${BASE}${path}`, {
    headers: { ...baseHeaders, 'x-correlation-id': correlationId() },
    tags: { name },
    timeout: TIMEOUT,
  });
}

/**
 * Authed POST with a stable endpoint name tag.
 * @param {string} name  threshold-stable endpoint name
 * @param {string} path  path starting with /v1/
 * @param {object} body  JSON-serializable request body
 */
export function authedPost(name, path, body) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers: { ...baseHeaders, 'x-correlation-id': correlationId() },
    tags: { name },
    timeout: TIMEOUT,
  });
}

/** Parse the response body as JSON, tolerating empty/malformed (returns null). */
export function bodyOf(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Assert the contract envelope on any response. Registers k6 checks under
 * the given family so failures surface as `checks` breaches (thresholded in
 * lib/thresholds.js) with a named trail in the end-of-run summary.
 *
 * @param {Response} res              k6 http response
 * @param {number}   expectedStatus   the contract status for this call
 * @param {string}   family           check family label, e.g. "receivables list"
 * @param {boolean}  wantData         true (default) → success envelope must carry `data`
 * @returns {object|null} the parsed body (null when not JSON)
 */
export function expectEnvelope(res, expectedStatus, family, wantData = true) {
  const okStatus = check(res, {
    [`${family}: status ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });
  const hasRequestId = check(res, {
    [`${family}: x-request-id present`]: (r) =>
      r.headers['X-Request-Id'] !== undefined || r.headers['x-request-id'] !== undefined,
  });
  const body = bodyOf(res);
  let shapeOk = okStatus; // don't double-punish when the status already failed
  if (body !== null) {
    if (res.status < 400) {
      shapeOk = check(body, {
        [`${family}: success envelope carries data`]: (b) => wantData === false || (b && b.data !== undefined),
      });
    } else {
      shapeOk = check(body, {
        [`${family}: error envelope carries error.code`]: (b) =>
          b && b.error && typeof b.error.code === 'string' && typeof b.requestId === 'string',
      });
    }
  }
  void shapeOk; // the checks carry the verdict; body is returned for chaining
  return body;
}

/**
 * Fetch one page of a paginated list and return `{ ids, total }` from the
 * envelope (`data.<collection>` is an array; `meta.pagination.total` rides
 * alongside). Returns `{ ids: [], total: 0 }` on any failure so setup() can
 * degrade to "no per-id gets" instead of crashing the run.
 */
export function listPage(name, path, collection) {
  const res = authedGet(name, path);
  const body = expectEnvelope(res, 200, name);
  const items = (body && body.data && body.data[collection]) || [];
  const meta = (body && body.meta && body.meta.pagination) || {};
  return {
    ids: items.map((it) => it.id).filter((id) => typeof id === 'string'),
    total: typeof meta.total === 'number' ? meta.total : items.length,
  };
}

/**
 * Unique-per-iteration Daraja-ish external reference. Uniqueness (not
 * format) is what the R9 funnel requires of replays; the prefix marks these
 * rows as harness traffic so a cleanup query can find them.
 */
export function externalRef() {
  return `perf-${__VU}-${__ITER}-${Date.now()}`;
}

'use strict';
/**
 * perf/scenarios/reads.js — authed READ mix over the mounted /v1 surface
 * (issue #147): receivables / payments / collections-cases lists+gets, the
 * LEDGER read surface (accounts + journal) and the adjustments feed —
 * everything the collections/finance consoles page through.
 *
 * Surface exercised (all with the fixture ApiKey credential):
 *   GET /v1/receivables            (receivables:read)
 *   GET /v1/receivables/{id}       (receivables:read)
 *   GET /v1/payments               (payments:read)
 *   GET /v1/payments/{id}          (payments:read)
 *   GET /v1/collections/cases      (collections:read)
 *   GET /v1/collections/cases/{id} (collections:read)
 *   GET /v1/ledger/accounts        (ledger:read — list-only surface)
 *   GET /v1/ledger/entries         (ledger:read — list-only surface)
 *   GET /v1/adjustments            (adjustments:request — list-only surface)
 *
 * Shape: closed-model constant VUs for the run duration with a weighted op
 * mix per iteration — the mix a collections console produces: list views
 * dominate, gets follow on list results, the GL journal + adjustments feed
 * are the finance tabs, deep cursor walks are the rare tail. Ledger and
 * adjustments are list-only by contract (no get-by-id ops are mounted).
 *
 * setup() pages each list ONCE to harvest real per-resource ids (no invented
 * ids — a 404 would measure the error path, not the read path).
 *
 * Run:  k6 run perf/scenarios/reads.js
 * Sizing: PERF_READS_VUS (default 10), PERF_READS_DURATION (default 2m).
 */

import exec from 'k6/execution';
import { scenarioOptions } from '../lib/options.js';
import { config } from '../lib/config.js';
import { authedGet, expectEnvelope, listPage } from '../lib/helpers.js';
import { thresholds } from '../lib/thresholds.js';

export const options = scenarioOptions('reads', thresholds);

// Weighted op mix (exec weights, sums to 100): lists 40, gets 25, ledger 15,
// adjustments feed 10, cursor walk 10.
const MIX = { lists: 40, gets: 25, ledger: 15, adjustments: 10, walk: 10 };

// Every list surface of the read mix — the cursor walk rotates through these.
const FAMILIES = [
  ['GET /v1/receivables', '/v1/receivables', 'receivables'],
  ['GET /v1/payments', '/v1/payments', 'payments'],
  ['GET /v1/collections/cases', '/v1/collections/cases', 'cases'],
  ['GET /v1/ledger/accounts', '/v1/ledger/accounts', 'accounts'],
  ['GET /v1/ledger/entries', '/v1/ledger/entries', 'entries'],
  ['GET /v1/adjustments', '/v1/adjustments', 'adjustments'],
];

// setup runs ONCE (not per VU): harvest fixture ids + page totals.
export function setup() {
  const pageSize = config.pageSize;
  const receivables = listPage('GET /v1/receivables', `/v1/receivables?limit=${pageSize}`, 'receivables');
  const payments = listPage('GET /v1/payments', `/v1/payments?limit=${pageSize}`, 'payments');
  const cases = listPage('GET /v1/collections/cases', `/v1/collections/cases?limit=${pageSize}`, 'cases');
  return {
    receivableIds: receivables.ids,
    paymentIds: payments.ids,
    caseIds: cases.ids,
    totals: { receivables: receivables.total, payments: payments.total, cases: cases.total },
  };
}

export default function (data) {
  const roll = exec.scenario.iterationInTest % 100;
  if (roll < MIX.walk) {
    cursorWalk();
  } else if (roll < MIX.walk + MIX.adjustments) {
    listAdjustments();
  } else if (roll < MIX.walk + MIX.adjustments + MIX.ledger) {
    listLedger();
  } else if (roll < MIX.walk + MIX.adjustments + MIX.ledger + MIX.gets) {
    getOne(data);
  } else {
    listAll();
  }
}

/** The three console landing lists, one page each. */
function listAll() {
  authedGet('GET /v1/receivables', `/v1/receivables?limit=${config.pageSize}`);
  authedGet('GET /v1/payments', `/v1/payments?limit=${config.pageSize}`);
  authedGet('GET /v1/collections/cases', `/v1/collections/cases?limit=${config.pageSize}`);
}

/** The GL tabs: chart of accounts + the journal (line-grained). */
function listLedger() {
  expectEnvelope(authedGet('GET /v1/ledger/accounts', `/v1/ledger/accounts?limit=${config.pageSize}`), 200, 'ledger accounts list');
  expectEnvelope(authedGet('GET /v1/ledger/entries', `/v1/ledger/entries?limit=${config.pageSize}`), 200, 'ledger entries list');
}

/** The finance adjustments tab (refunds + credit notes, discriminated feed). */
function listAdjustments() {
  expectEnvelope(authedGet('GET /v1/adjustments', `/v1/adjustments?limit=${config.pageSize}`), 200, 'adjustments list');
}

/** One get per resource family, from setup()-harvested ids. */
function getOne(data) {
  if (data.receivableIds.length) {
    const id = data.receivableIds[exec.scenario.iterationInTest % data.receivableIds.length];
    expectEnvelope(authedGet('GET /v1/receivables/{id}', `/v1/receivables/${id}`), 200, 'receivable get');
  }
  if (data.paymentIds.length) {
    const id = data.paymentIds[exec.scenario.iterationInTest % data.paymentIds.length];
    expectEnvelope(authedGet('GET /v1/payments/{id}', `/v1/payments/${id}`), 200, 'payment get');
  }
  if (data.caseIds.length) {
    const id = data.caseIds[exec.scenario.iterationInTest % data.caseIds.length];
    expectEnvelope(authedGet('GET /v1/collections/cases/{id}', `/v1/collections/cases/${id}`), 200, 'case get');
  }
}

/** The rare tail: follow meta.pagination.nextCursor up to PERF_MAX_LIST_PAGES. */
function cursorWalk() {
  const [name, pathBase] = FAMILIES[exec.scenario.iterationInTest % FAMILIES.length];
  let cursor = null;
  for (let page = 0; page < config.maxListPages; page++) {
    const path = `${pathBase}?limit=${config.pageSize}${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = expectEnvelope(authedGet(name, path), 200, name);
    const next = body && body.meta && body.meta.pagination && body.meta.pagination.nextCursor;
    if (next === null || next === undefined || next === '') break;
    cursor = next;
  }
}

'use strict';
/**
 * perf/scenarios/payments-write.js — the payments WRITE path (issue #147):
 * the Daraja-callback funnel, i.e. the issue's "webhook-ish POST" surface.
 *
 * Flow per main iteration (mirrors how real Daraja callbacks arrive):
 *   1. POST /v1/payments/intake                  → 201 (state: initiated)
 *   2. POST /v1/payments/{id}/confirmations      → 201 (state: confirmed)
 * plus an idempotent replay leg exercising R9 (at-least-once semantics):
 *   3. POST /v1/payments/intake (SAME body)      → 200 (duplicate: true)
 *
 * Uniqueness: every first-contact intake carries a fresh
 * (externalRef, idempotencyKey) pair (`perf-<vu>-<iter>-<epoch>`), so the
 * run writes REAL payments and appends REAL outbox facts — run it against a
 * disposable database (fuatilia_perf), never against an environment whose
 * data you want to keep.
 *
 * Run:  k6 run perf/scenarios/payments-write.js
 * Sizing: PERF_WRITE_VUS (default 5), PERF_WRITE_DURATION (default 1m).
 */

import exec from 'k6/execution';
import { check } from 'k6';
import { scenarioOptions } from '../lib/options.js';
import { config } from '../lib/config.js';
import { authedPost, authedGet, expectEnvelope, externalRef } from '../lib/helpers.js';
import { thresholds } from '../lib/thresholds.js';

export const options = scenarioOptions('payments-write', thresholds);

// Money: KES minor units (int64 all the way — floats are banned from money).
const AMOUNT = { minor: 750000, currency: 'KES' };

// Weighted exec mix: the intake→confirm chain dominates; the replay leg and
// a read-your-write get keep R9 + fund-truth reads honest under load.
export const execMix = { intakeConfirm: 80, intakeReplay: 12, readYourWrite: 8 };

export default function () {
  const roll = exec.scenario.iterationInTest % 100;
  if (roll < execMix.intakeConfirm) {
    intakeThenConfirm();
  } else if (roll < execMix.intakeConfirm + execMix.intakeReplay) {
    intakeThenReplay();
  } else {
    readYourWrite();
  }
}

/** The main write path: initiate → confirm (both 201 on first contact). */
function intakeThenConfirm() {
  const ref = externalRef();
  const idem = `${ref}-idem`;
  const body = {
    channel: 'c2b',
    externalRef: ref,
    idempotencyKey: idem,
    amount: AMOUNT,
  };

  const intake = authedPost('POST /v1/payments/intake', '/v1/payments/intake', body);
  const intakeBody = expectEnvelope(intake, 201, 'intake');
  const paymentId = intakeBody && intakeBody.data && intakeBody.data.payment && intakeBody.data.payment.id;
  if (!paymentId) return; // checks already carry the verdict; nothing to confirm

  expectEnvelope(
    authedPost('POST /v1/payments/{id}/confirmations', `/v1/payments/${paymentId}/confirmations`, { amount: AMOUNT }),
    201,
    'confirm',
  );
}

/** R9 replay: the SAME callback arriving twice answers 200 duplicate:true. */
function intakeThenReplay() {
  const ref = externalRef();
  const body = {
    channel: 'c2b',
    externalRef: ref,
    idempotencyKey: `${ref}-idem`,
    amount: AMOUNT,
  };

  const first = authedPost('POST /v1/payments/intake', '/v1/payments/intake', body);
  expectEnvelope(first, 201, 'intake (replay leg, first contact)');

  const replay = authedPost('POST /v1/payments/intake', '/v1/payments/intake', body);
  const replayBody = expectEnvelope(replay, 200, 'intake replay (duplicate:true)');
  const duplicate = replayBody && replayBody.data && replayBody.data.duplicate;
  check({ duplicate }, {
    'intake replay: data.duplicate is true': (d) => d.duplicate === true,
  });
}

/** Read-your-write: a just-confirmed payment must be immediately listable. */
function readYourWrite() {
  const ref = externalRef();
  const body = { channel: 'stk', externalRef: ref, idempotencyKey: `${ref}-idem`, amount: AMOUNT };
  const intake = authedPost('POST /v1/payments/intake', '/v1/payments/intake', body);
  const intakeBody = expectEnvelope(intake, 201, 'intake (read-your-write leg)');
  const paymentId = intakeBody && intakeBody.data && intakeBody.data.payment && intakeBody.data.payment.id;
  if (!paymentId) return;
  expectEnvelope(
    authedPost('POST /v1/payments/{id}/confirmations', `/v1/payments/${paymentId}/confirmations`, { amount: AMOUNT }),
    201,
    'confirm (read-your-write leg)',
  );
  authedGet('GET /v1/payments', `/v1/payments?limit=${config.pageSize}`);
}

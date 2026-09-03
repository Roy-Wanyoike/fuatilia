/**
 * Conformance harness (issue #25, F15) — plain-data scenarios proving that the
 * domain satisfies Daraja semantics END-TO-END under transport hostility.
 *
 * Each scenario pins a SPEC / review requirement (K1, C5, R9, C1, R1, R2, C4),
 * builds its world + delivery schedule, and lists named checks evaluated
 * against the `SimulationRun`. `runConformance()` executes every scenario and
 * returns a report — adding a fixture or a scenario is an additive row, never
 * a rewrite. Pure: the only inputs are fixture data and the harness itself.
 */
import { uuidFromSeed } from '../../domain/payments';
import { DARAJA_STK_OUTCOMES, replayEach, resultCodeOutcome, shuffledSchedule, simulate } from './simulator';
import type { SimulationRun } from './simulator';

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export interface ConformanceCheck {
  readonly id: string;
  /** The SPEC section / review finding this check proves. */
  readonly requirement: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface ConformanceScenario {
  readonly id: string;
  readonly requirement: string;
  readonly note: string;
  readonly run: () => SimulationRun;
  readonly evaluate: (run: SimulationRun) => readonly ConformanceCheck[];
}

export interface ConformanceResult {
  readonly scenarioId: string;
  readonly requirement: string;
  readonly pass: boolean;
  readonly checks: readonly ConformanceCheck[];
}

export interface ConformanceReport {
  readonly pass: boolean;
  readonly scenarios: readonly ConformanceResult[];
}

const check = (id: string, requirement: string, pass: boolean, detail: string): ConformanceCheck => ({
  id,
  requirement,
  pass,
  detail,
});

const sumAllocated = (run: SimulationRun, paymentId: string): bigint =>
  run.allocations
    .filter((row) => row.sourceId === paymentId)
    .reduce((sum, row) => sum + row.amountMinor.amount, 0n);

// ---------------------------------------------------------------------------
// Shared worlds — synthetic merchant-side context (Kenyan-realistic, no PII)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const worldSingle = {
  invoices: [
    { key: 'inv-1042', invoiceNumber: 'INV-1042', balanceMinor: 250_000, dueDateMs: 10 * DAY_MS },
  ],
  defaultCustomerId: 'cust-101',
};

const worldMulti = {
  invoices: [
    { key: 'inv-2077', invoiceNumber: 'INV-2077', balanceMinor: 800_000, dueDateMs: 12 * DAY_MS },
    { key: 'inv-2078', invoiceNumber: 'INV-2078', balanceMinor: 900_000, dueDateMs: 40 * DAY_MS },
  ],
  defaultCustomerId: 'cust-101',
};

const STK_CHECKOUTS = [
  'ws_CO_12092025143105741', // success (code 0)
  'ws_CO_12092025144000202', // cancelled (1)
  'ws_CO_12092025145530103', // timeout (2)
  'ws_CO_12092025151022104', // cancelled (1032)
  'ws_CO_12092025152140505', // DS timeout (1037)
  'ws_CO_12092025153309906', // system error (1001)
] as const;

const worldStk = {
  invoices: [],
  stkInitiations: STK_CHECKOUTS.map((checkoutRequestId) => ({ checkoutRequestId, requestedMinor: 250_000 })),
  defaultCustomerId: 'cust-101',
};

const singleJourney = [
  { atMs: 0, fixtureId: 'c2b.validation.paybill-single-invoice' },
  { atMs: 1_000, fixtureId: 'c2b.confirmation.paybill-single-invoice' },
] as const;

const CLOCK = { startMs: 1_757_600_000_000, tickMs: 250 };

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const CONFORMANCE_SCENARIOS: readonly ConformanceScenario[] = [
  {
    id: 'c2b.at-least-once-idempotent',
    requirement: 'K1 / C5 / R9 — at-least-once delivery resolves to exactly one payment',
    note: 'Single-invoice journey replayed 5×, delayed copies; duplicates fire the tripwire once each and nothing downstream re-runs.',
    run: () => simulate(replayEach([...singleJourney], 5, 500), worldSingle, { clock: CLOCK }),
    evaluate: (run) => {
      const payment = run.payments[0];
      return [
        check('exactly-one-payment', 'C5 — one creation funnel', run.payments.length === 1 && payment !== undefined,
          `payments=${run.payments.length}`),
        check('external-ref', 'R9 — identity is the Daraja TransID', payment?.externalRef === 'SBK41XQ7RT',
          `externalRef=${String(payment?.externalRef)}`),
        check('confirmed-money', 'docs/05 — confirmed once', payment?.confirmedMinor?.amount === 250_000n,
          `confirmedMinor=${String(payment?.confirmedMinor?.amount)}`),
        check('duplicates-counted', 'at-least-once arithmetic', run.summary.duplicates === 4,
          `summary=${JSON.stringify(run.summary)}`),
        check('tripwire-per-duplicate', 'R9 — tripwire once per duplicate', run.tripwires === run.summary.duplicates,
          `tripwires=${run.tripwires}`),
        check('nothing-rejected', 'K1 — retries are duplicates, not failures', run.rejections.length === 0,
          `rejections=${run.rejections.length}`),
      ];
    },
  },
  {
    id: 'c2b.reconciliation-targets-payment',
    requirement: 'C1 / R5 — the reconciliation match points at the Payment',
    note: 'Ordered journey: validation acknowledged, confirmation accepted, matched to INV-1042, fully allocated.',
    run: () => simulate([...singleJourney], worldSingle, { clock: CLOCK }),
    evaluate: (run) => {
      const payment = run.payments[0];
      const match = run.matches[0];
      return [
        check('single-match', 'C1 — one journey, one match', run.matches.length === 1 && match !== undefined,
          `matches=${run.matches.length}`),
        check('match-targets-payment', 'C1/R5 — match.paymentId is the ONLY target',
          match !== undefined && payment !== undefined && match.paymentId === payment.id,
          `matchPayment=${String(match?.paymentId)} payment=${String(payment?.id)}`),
        check('match-refs', 'R5 — payer-typed reference kept', match?.declaredRefs[0] === 'INV-1042',
          `declaredRefs=${JSON.stringify(match?.declaredRefs)}`),
        check('allocation-covers-balance', 'R1 — money lands on the invoice',
          run.allocations.length === 1 &&
          run.allocations[0]?.receivableId === uuidFromSeed('receivable:inv-1042') &&
          run.allocations[0]?.amountMinor.amount === 250_000n,
          `allocations=${JSON.stringify(run.allocations.map((a) => [a.receivableId, String(a.amountMinor)]))}`),
      ];
    },
  },
  {
    id: 'c2b.multi-invoice-conservation',
    requirement: 'R1 / R2 — one transfer explaining two invoices; no cent created or destroyed',
    note: 'KES 15,000.00 pays INV-2077 (8,000.00) in full and INV-2078 (9,000.00) partially, FIFO.',
    run: () => simulate([{ atMs: 0, fixtureId: 'c2b.confirmation.paybill-multi-ref' }], worldMulti, { clock: CLOCK }),
    evaluate: (run) => {
      const payment = run.payments[0];
      const total = run.allocations.reduce((sum, row) => sum + row.amountMinor.amount, 0n);
      return [
        check('one-payment', 'C5', run.payments.length === 1 && payment !== undefined, `payments=${run.payments.length}`),
        check('splits-across-two-invoices', 'R5 — multi-invoice representable',
          run.allocations.length === 2 &&
          run.allocations[0]?.receivableId === uuidFromSeed('receivable:inv-2077') &&
          run.allocations[1]?.receivableId === uuidFromSeed('receivable:inv-2078'),
          `rows=${JSON.stringify(run.allocations.map((a) => a.receivableId))}`),
        check('full-then-partial', 'R1 — FIFO oldest-first, full then partial',
          run.allocations[0]?.amountMinor.amount === 800_000n && run.allocations[1]?.amountMinor.amount === 700_000n,
          `amounts=${JSON.stringify(run.allocations.map((a) => String(a.amountMinor)))}`),
        check('conservation', 'R1 — applied == confirmed, nothing destroyed',
          total === 1_500_000n && payment?.confirmedMinor?.amount === 1_500_000n,
          `applied=${total} confirmed=${String(payment?.confirmedMinor?.amount)}`),
        check('no-over-allocation', 'R2 — per-invoice ceiling',
          run.allocations.every((row, i) => row.amountMinor.amount <= [800_000n, 900_000n][i]!),
          'rows within invoice balances'),
      ];
    },
  },
  {
    id: 'c2b.tampered-amount-dead-lettered',
    requirement: 'K1 — same TransID with different money is tampering, not a retry',
    note: 'Replay of journey SBK41XQ7RT carrying KES 3,500.00 after the genuine KES 2,500.00 landed.',
    run: () =>
      simulate(
        [
          { atMs: 0, fixtureId: 'c2b.confirmation.paybill-single-invoice' },
          { atMs: 1_000, fixtureId: 'c2b.confirmation.tampered-amount' },
        ],
        worldSingle,
        { clock: CLOCK },
      ),
    evaluate: (run) => [
      check('tamper-rejected', 'K1 — dead-lettered at intake',
        run.rejections.length === 1 && run.rejections[0]?.code === 'DUPLICATE_AMOUNT_MISMATCH',
        `rejections=${JSON.stringify(run.rejections.map((r) => r.code))}`),
      check('original-money-stands', 'R9 — the genuine payment is untouched',
        run.payments.length === 1 && run.payments[0]?.confirmedMinor?.amount === 250_000n,
        `confirmed=${String(run.payments[0]?.confirmedMinor?.amount)}`),
      check('no-tripwire-for-tampering', 'R9 — mismatch is tampering (rejected), not a duplicate',
        run.tripwires === 0, `tripwires=${run.tripwires}`),
    ],
  },
  {
    id: 'c2b.unidentified-money-parks-c4',
    requirement: 'C4 — money with no account reference parks on the customer, unapplied',
    note: 'Pay Bill confirmation with an empty BillRefNumber; the world supplies the default customer.',
    run: () => simulate([{ atMs: 0, fixtureId: 'c2b.confirmation.paybill-no-ref' }], worldSingle, { clock: CLOCK }),
    evaluate: (run) => {
      const payment = run.payments[0];
      return [
        check('parks-on-customer', 'C4 — identified to the default customer',
          payment?.customerId === uuidFromSeed('customer:cust-101'),
          `customerId=${String(payment?.customerId)}`),
        check('no-match-no-allocation', 'C4 — unapplied, not force-matched',
          run.matches.length === 0 && run.allocations.length === 0,
          `matches=${run.matches.length} allocations=${run.allocations.length}`),
        check('conservation', 'R1 — the money exists', payment?.confirmedMinor?.amount === 420_000n,
          `confirmed=${String(payment?.confirmedMinor?.amount)}`),
      ];
    },
  },
  {
    id: 'stk.result-code-matrix',
    requirement: 'SPEC Daraja — ResultCode 0 completes; observed non-zero codes abandon; unmapped codes fail safe',
    note: 'All six STK journeys in one run against initiation records; success parks unapplied (no invoice refs).',
    run: () =>
      simulate(
        STK_CHECKOUTS.map((fixtureId, i) => ({ atMs: i * 1_000, fixtureId: [
          'stk.success.metadata-complete',
          'stk.cancelled-by-user.code-1',
          'stk.timeout.code-2',
          'stk.cancelled-by-user.code-1032',
          'stk.unreachable.code-1037',
          'stk.system-error.code-1001',
        ][i]! })),
        worldStk,
        { clock: CLOCK },
      ),
    evaluate: (run) => {
      const success = run.payments.find((p) => p.externalRef === 'SBK81KZ9QF'); // MpesaReceiptNumber leads on success
      const failedStates = run.payments.filter((p) => p.state === 'failed');
      const expectedFailureCodes = new Map(DARAJA_STK_OUTCOMES.filter((e) => e.code !== 0).map((e) => [
        e.outcome.failureCode!,
        e.code,
      ]));
      return [
        check('one-payment-per-journey', 'C5 — six callbacks, six payments', run.payments.length === 6,
          `payments=${run.payments.length}`),
        check('success-parks-unapplied', 'C4 — success money stands, no invoice to fill',
          success !== undefined && success.state === 'unapplied' && success.confirmedMinor?.amount === 250_000n,
          `success=${success ? `${success.state}/${String(success.confirmedMinor?.amount)}` : 'missing'}`),
        check('five-failures', 'SPEC — result codes 1/2/1032/1037/1001 never move money', failedStates.length === 5,
          `failed=${failedStates.length}`),
        check('failure-codes', 'SPEC — stable failureCode per code path',
          failedStates.every((p) =>
            p.failureCode !== undefined &&
            (expectedFailureCodes.has(p.failureCode) || /^STK_RESULT_\d+$/.test(p.failureCode)),
          ) && failedStates.some((p) => p.failureCode === 'STK_RESULT_1001'),
          `codes=${JSON.stringify(failedStates.map((p) => p.failureCode))}`),
        check('failed-has-no-confirmed-money', 'docs/05 — failed payments carry no confirmedMinor',
          failedStates.every((p) => p.confirmedMinor === undefined),
          'no confirmedMinor on failures'),
      ];
    },
  },
  {
    id: 'transport.gap-no-callback-no-money',
    requirement: 'at-least-once complement — a callback that never arrives never becomes money',
    note: 'Validation delivered, confirmation gapped: the gate is acknowledged, zero payments exist.',
    run: () => simulate([{ atMs: 0, fixtureId: 'c2b.validation.paybill-single-invoice' }], worldSingle, { clock: CLOCK }),
    evaluate: (run) => [
      check('no-money', 'C5 — no confirmation, no payment', run.payments.length === 0, `payments=${run.payments.length}`),
      check('gate-acknowledged', 'K1 — validation is a gate, not a fact', run.summary.acknowledged === 1,
        `summary=${JSON.stringify(run.summary)}`),
      check('clean-ledger', 'R1 — no matches, no allocations, no events on the money path',
        run.matches.length === 0 && run.allocations.length === 0,
        `matches=${run.matches.length} allocations=${run.allocations.length}`),
    ],
  },
  {
    id: 'transport.out-of-order-arrival',
    requirement: 'K1 — the domain does not depend on callback ordering',
    note: 'Seeded shuffle delivers confirmation and validation in adversarial order; the money still lands once.',
    run: () => simulate(shuffledSchedule([...singleJourney], 42), worldSingle, { clock: CLOCK }),
    evaluate: (run) => [
      check('still-one-payment', 'C5/R9 — order-independent idempotency',
        run.payments.length === 1 && run.payments[0]?.confirmedMinor?.amount === 250_000n,
        `payments=${run.payments.length}`),
      check('match-exists', 'C1 — reconciliation reached', run.matches.length === 1, `matches=${run.matches.length}`),
      check('conservation', 'R1 — fully applied', sumAllocated(run, run.payments[0]?.id ?? '') === 250_000n,
        `applied=${sumAllocated(run, run.payments[0]?.id ?? '')}`),
    ],
  },
];

export const runScenario = (scenario: ConformanceScenario): ConformanceResult => {
  const run = scenario.run();
  const checks = scenario.evaluate(run);
  return {
    scenarioId: scenario.id,
    requirement: scenario.requirement,
    pass: checks.every((c) => c.pass),
    checks,
  };
};

export const runConformance = (
  scenarios: readonly ConformanceScenario[] = CONFORMANCE_SCENARIOS,
): ConformanceReport => {
  const results = scenarios.map(runScenario);
  return { pass: results.every((r) => r.pass), scenarios: results };
};

// Re-exported so consumers can build additive scenarios without reaching deeper.
export { resultCodeOutcome };

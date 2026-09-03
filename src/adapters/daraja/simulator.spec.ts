/**
 * Simulator conformance (issue #25, F15) — the pure Daraja transport harness.
 *
 * Proves: deterministic clock/world construction; at-least-once replay and
 * seeded shuffling; harness-misuse refusals; the end-to-end C2B journey
 * (validation gate → confirmation → matched → allocated) with per-stream
 * event ordering; the STK result-code matrix; gap and B2C observation
 * semantics; and run-level determinism.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import { uuidFromSeed } from '../../domain/payments';
import { DARAJA_ERRORS } from './codes';
import {
  DARAJA_STK_OUTCOMES,
  createSimClock,
  replayEach,
  resultCodeOutcome,
  resolveWorld,
  shuffledSchedule,
  simulate,
} from './simulator';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

/** JSON with bigint support — Money carries bigint amounts. */
const bigintSafe = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

const worldSingle = {
  invoices: [{ key: 'inv-1042', invoiceNumber: 'INV-1042', balanceMinor: 250_000, dueDateMs: 864_000_000 }],
  defaultCustomerId: 'cust-101',
};

const journey = [
  { atMs: 0, fixtureId: 'c2b.validation.paybill-single-invoice' },
  { atMs: 1_000, fixtureId: 'c2b.confirmation.paybill-single-invoice' },
];

const CLOCK = { startMs: 1_757_600_000_000, tickMs: 250 };

describe('createSimClock', () => {
  it('advances by tickMs per read, deterministically', () => {
    const clock = createSimClock({ startMs: 1_000, tickMs: 5 });
    expect(clock.now().getTime()).toBe(1_000);
    expect(clock.now().getTime()).toBe(1_005);
    expect(clock.now().getTime()).toBe(1_010);
    expect(createSimClock({ startMs: 7 }).now().getTime()).toBe(7); // default tick 1000
  });

  it('refuses non-integer starts and non-positive ticks (table)', () => {
    for (const bad of [{ startMs: 1.5 }, { startMs: Number.NaN }, { startMs: 10, tickMs: 0 }, { startMs: 10, tickMs: -1 }]) {
      expectCode(() => createSimClock(bad), DARAJA_ERRORS.CLOCK_INVALID);
    }
  });
});

describe('resolveWorld', () => {
  it('derives stable opaque ids from keys', () => {
    const world = resolveWorld(worldSingle);
    expect(world.invoices[0]!.receivableId).toBe(uuidFromSeed('receivable:inv-1042'));
    expect(world.defaultCustomerId).toBe(uuidFromSeed('customer:cust-101'));
    expect(resolveWorld(worldSingle).invoices[0]!.receivableId).toBe(world.invoices[0]!.receivableId);
  });

  it('refuses misuse (table)', () => {
    const cases: readonly { readonly name: string; readonly world: Parameters<typeof resolveWorld>[0] }[] = [
      { name: 'blank key', world: { invoices: [{ key: '', invoiceNumber: 'A', balanceMinor: 1, dueDateMs: 0 }] } },
      { name: 'blank invoiceNumber', world: { invoices: [{ key: 'a', invoiceNumber: '', balanceMinor: 1, dueDateMs: 0 }] } },
      { name: 'fractional balance', world: { invoices: [{ key: 'a', invoiceNumber: 'A', balanceMinor: 1.5, dueDateMs: 0 }] } },
      { name: 'negative balance', world: { invoices: [{ key: 'a', invoiceNumber: 'A', balanceMinor: -1, dueDateMs: 0 }] } },
      { name: 'non-integer dueDateMs', world: { invoices: [{ key: 'a', invoiceNumber: 'A', balanceMinor: 1, dueDateMs: 1.5 }] } },
      {
        name: 'duplicate keys',
        world: {
          invoices: [
            { key: 'a', invoiceNumber: 'A', balanceMinor: 1, dueDateMs: 0 },
            { key: 'a', invoiceNumber: 'B', balanceMinor: 1, dueDateMs: 0 },
          ],
        },
      },
      { name: 'blank checkout id', world: { stkInitiations: [{ checkoutRequestId: '', requestedMinor: 1 }] } },
      {
        name: 'duplicate checkout id',
        world: {
          stkInitiations: [
            { checkoutRequestId: 'ws_CO_1', requestedMinor: 1 },
            { checkoutRequestId: 'ws_CO_1', requestedMinor: 2 },
          ],
        },
      },
      { name: 'blank defaultCustomerId', world: { defaultCustomerId: ' ' } },
    ];
    for (const c of cases) expectCode(() => resolveWorld(c.world), DARAJA_ERRORS.WORLD_INVALID);
  });
});

describe('schedules — replay and shuffle', () => {
  it('replayEach duplicates every delivery, preserving first-arrival order and spacing copies', () => {
    const replayed = replayEach(journey, 3, 700);
    expect(replayed).toHaveLength(6);
    expect(replayed.map((d) => d.fixtureId)).toEqual([
      journey[0]!.fixtureId, journey[0]!.fixtureId, journey[0]!.fixtureId,
      journey[1]!.fixtureId, journey[1]!.fixtureId, journey[1]!.fixtureId,
    ]);
    expect(replayed.map((d) => d.atMs)).toEqual([0, 700, 1400, 1000, 1700, 2400]);
    expectCode(() => replayEach(journey, 0), DARAJA_ERRORS.DELIVERY_INVALID);
  });

  it('shuffledSchedule is deterministic for a seed and always preserves the multiset', () => {
    const a = shuffledSchedule(journey, 42);
    const b = shuffledSchedule(journey, 42);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x.atMs - y.atMs)).toEqual([...journey].sort((x, y) => x.atMs - y.atMs));
  });

  it('refuses invalid schedules (table)', () => {
    for (const bad of [[{ atMs: -1, fixtureId: 'x' }], [{ atMs: 0, fixtureId: '' }], [{ atMs: 0.5, fixtureId: 'x' }], 'nope', 42]) {
      expectCode(() => simulate(bad as never, worldSingle, { clock: CLOCK }), DARAJA_ERRORS.DELIVERY_INVALID);
    }
    expectCode(() => replayEach(journey, 0), DARAJA_ERRORS.DELIVERY_INVALID);
    expectCode(() => replayEach(journey, 1.5), DARAJA_ERRORS.DELIVERY_INVALID);
  });

  it('surfaces harness misuse — an unknown fixture id throws DARAJA_FIXTURE_NOT_FOUND', () => {
    expectCode(
      () => simulate([{ atMs: 0, fixtureId: 'nope' }], worldSingle, { clock: CLOCK }),
      DARAJA_ERRORS.FIXTURE_NOT_FOUND,
    );
  });
});

describe('the C2B journey end-to-end', () => {
  const run = simulate(journey, worldSingle, { clock: CLOCK });

  it('validation is a gate, confirmation is the money fact', () => {
    expect(run.summary).toEqual({
      deliveries: 2,
      accepted: 1,
      duplicates: 0,
      acknowledged: 1,
      observed: 0,
      rejected: 0,
    });
    expect(run.payments).toHaveLength(1);
    const payment = run.payments[0]!;
    expect(payment.channel).toBe('c2b');
    expect(payment.externalRef).toBe('SBK41XQ7RT');
    expect(payment.idempotencyKey).toBe('daraja:c2b:SBK41XQ7RT');
    expect(payment.declaredRefs).toEqual(['INV-1042']);
    expect(payment.confirmedMinor?.amount).toBe(250_000n);
    expect(payment.state).toBe('allocated'); // fully allocated to INV-1042
  });

  it('the match points at the payment (C1) and the allocation row lands on the receivable (R1)', () => {
    const payment = run.payments[0]!;
    expect(run.matches).toHaveLength(1);
    expect(run.matches[0]!.paymentId).toBe(payment.id);
    expect(run.matches[0]!.declaredRefs).toContain('INV-1042');
    expect(run.allocations).toHaveLength(1);
    expect(run.allocations[0]!.receivableId).toBe(uuidFromSeed('receivable:inv-1042'));
    expect(run.allocations[0]!.amountMinor.amount).toBe(250_000n);
  });

  it('emits a deterministic, well-typed event stream', () => {
    const names = run.events.map((e) => e.name);
    expect(names).toContain('payment.initiated');
    expect(names).toContain('payment.confirmed');
    expect(names).toContain('reconciliation.paymentMatched');
    expect(names).toContain('allocation.executed');
    for (const event of run.events) {
      expect(['payments', 'allocation']).toContain(event.lane);
      expect(event.version).toBe(1);
      expect(() => new Date(event.occurredAt).toISOString()).not.toThrow();
      expect(event.payload).toBeTypeOf('object');
    }
    const run2 = simulate(journey, worldSingle, { clock: CLOCK });
    expect(bigintSafe(run2.events)).toEqual(bigintSafe(run.events)); // deterministic
  });

  it('keeps R1 conservation on every accepted payment', () => {
    for (const payment of run.payments) {
      const applied = run.allocations
        .filter((row) => row.sourceId === payment.id)
        .reduce((sum, row) => sum + row.amountMinor.amount, 0n);
      expect(applied).toBeLessThanOrEqual(payment.confirmedMinor?.amount ?? 0n);
    }
    const total = run.allocations.reduce((sum, row) => sum + row.amountMinor.amount, 0n);
    expect(total).toBe(250_000n);
  });
});

describe('at-least-once replay through the full funnel', () => {
  it('5× replay: one payment, four tripwires, nothing re-run downstream', () => {
    const run = simulate(replayEach(journey, 5, 500), worldSingle, { clock: CLOCK });
    expect(run.payments).toHaveLength(1);
    expect(run.summary.duplicates).toBe(4);
    expect(run.tripwires).toBe(4);
    expect(run.summary.accepted).toBe(1);
    expect(run.summary.acknowledged).toBe(5); // validation replays are gates, not duplicates
    // downstream facts exist exactly once despite 5 confirmations
    expect(run.matches).toHaveLength(1);
    expect(run.allocations).toHaveLength(1);
    expect(run.events.filter((e) => e.name === 'payment.confirmed')).toHaveLength(1);
    expect(run.events.filter((e) => e.name === 'payments.duplicateCallbackObserved')).toHaveLength(4);
  });

  it('a seeded shuffle arrives out of order — the money still lands once', () => {
    const shuffled = shuffledSchedule(journey, 42);
    const run = simulate(shuffled, worldSingle, { clock: CLOCK });
    expect(run.payments).toHaveLength(1);
    expect(run.payments[0]!.confirmedMinor?.amount).toBe(250_000n);
    expect(run.matches).toHaveLength(1);
    expect(run.rejections).toHaveLength(0);
  });
});

describe('the STK result-code matrix', () => {
  const checkouts = [
    'ws_CO_12092025143105741',
    'ws_CO_12092025144000202',
    'ws_CO_12092025145530103',
    'ws_CO_12092025151022104',
    'ws_CO_12092025152140505',
    'ws_CO_12092025153309906',
  ];
  const worldStk = {
    invoices: [],
    stkInitiations: checkouts.map((checkoutRequestId) => ({ checkoutRequestId, requestedMinor: 250_000 })),
    defaultCustomerId: 'cust-101',
  };
  const fixtureIds = [
    'stk.success.metadata-complete',
    'stk.cancelled-by-user.code-1',
    'stk.timeout.code-2',
    'stk.cancelled-by-user.code-1032',
    'stk.unreachable.code-1037',
    'stk.system-error.code-1001',
  ];

  it('maps every wire ResultCode through the published table (0 → money, others → failed)', () => {
    const run = simulate(
      fixtureIds.map((fixtureId, i) => ({ atMs: i * 1_000, fixtureId })),
      worldStk,
      { clock: CLOCK },
    );
    expect(run.payments).toHaveLength(6);
    for (const fixtureId of fixtureIds) {
      const delivery = run.deliveries.find((d) => d.fixtureId === fixtureId)!;
      expect(delivery.status).toBe('accepted');
      const checkoutId = delivery.journeyKey?.slice('stk:'.length) ?? '';
      const payment = run.payments.find((p) => p.idempotencyKey === `daraja:stk:${checkoutId}`)!;
      const code = Number(fixtureId.match(/code-(\d+)/)?.[1] ?? 0);
      const outcome = resultCodeOutcome(code);
      if (outcome.kind === 'completed') {
        expect(payment.state, fixtureId).toBe('unapplied'); // success money parks (no invoice refs)
        expect(payment.confirmedMinor?.amount, fixtureId).toBe(250_000n);
      } else {
        expect(payment.state, fixtureId).toBe('failed');
        expect(payment.failureCode, fixtureId).toBe(outcome.failureCode);
        expect(payment.confirmedMinor, fixtureId).toBeUndefined();
      }
    }
    expect(run.allocations).toHaveLength(0); // no invoice refs anywhere in this world
  });

  it('the exported table stays aligned with the safe default', () => {
    expect(DARAJA_STK_OUTCOMES.map((e) => e.code)).toEqual([0, 1, 2, 1032, 1037]);
    expect(resultCodeOutcome(0).kind).toBe('completed');
    expect(resultCodeOutcome(1001)).toEqual({ kind: 'failed', failureCode: 'STK_RESULT_1001' });
    for (const entry of DARAJA_STK_OUTCOMES) {
      if (entry.code !== 0) expect(entry.outcome.failureCode, String(entry.code)).toBeTruthy();
    }
  });
});

describe('gaps, B2C observation, and unidentified money', () => {
  it('a gapped confirmation leaves zero payments (the gate was acknowledged, nothing more)', () => {
    const run = simulate([journey[0]!], worldSingle, { clock: CLOCK });
    expect(run.payments).toHaveLength(0);
    expect(run.summary.acknowledged).toBe(1);
    expect(run.matches).toHaveLength(0);
    expect(run.allocations).toHaveLength(0);
  });

  it('an initiated STK push whose callback never arrives leaves zero payments', () => {
    const run = simulate([], worldSingle, { clock: CLOCK });
    expect(run.deliveries).toHaveLength(0);
    expect(run.payments).toHaveLength(0);
  });

  it('B2C results are observed as outflow evidence — never an intake command', () => {
    const run = simulate([{ atMs: 0, fixtureId: 'b2c.payout-failed' }], worldSingle, { clock: CLOCK });
    expect(run.summary.observed).toBe(1);
    expect(run.payments).toHaveLength(0);
  });

  it('unidentified money parks on the default customer (C4) — no match, no allocation', () => {
    const run = simulate([{ atMs: 0, fixtureId: 'c2b.confirmation.paybill-no-ref' }], worldSingle, { clock: CLOCK });
    expect(run.payments).toHaveLength(1);
    expect(run.payments[0]!.customerId).toBe(uuidFromSeed('customer:cust-101'));
    expect(run.matches).toHaveLength(0);
    expect(run.allocations).toHaveLength(0);
    expect(run.payments[0]!.confirmedMinor?.amount).toBe(420_000n);
  });

  it('tampered money (same TransID, different amount) is dead-lettered by the domain', () => {
    const run = simulate(
      [
        { atMs: 0, fixtureId: 'c2b.confirmation.paybill-single-invoice' },
        { atMs: 1_000, fixtureId: 'c2b.confirmation.tampered-amount' },
      ],
      worldSingle,
      { clock: CLOCK },
    );
    expect(run.rejections).toHaveLength(1);
    expect(run.rejections[0]!.code).toBe('DUPLICATE_AMOUNT_MISMATCH');
    expect(run.tripwires).toBe(0); // tampering is NOT a duplicate
    expect(run.payments).toHaveLength(1);
    expect(run.payments[0]!.confirmedMinor?.amount).toBe(250_000n); // the genuine money stands
  });
});

describe('run-level determinism', () => {
  it('identical worlds + schedules + clocks produce byte-identical runs', () => {
    const a = simulate(replayEach(journey, 3, 250), worldSingle, { clock: CLOCK });
    const b = simulate(replayEach(journey, 3, 250), worldSingle, { clock: CLOCK });
    expect(bigintSafe(a)).toBe(bigintSafe(b));
  });
});

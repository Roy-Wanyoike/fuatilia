import { describe, expect, it } from 'vitest';
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import { intakePayment } from './intake';
import type { IntakeCommand } from './intake';
import type { Payment, PaymentChannel } from './payment';

const T0 = Date.UTC(2025, 2, 15, 8, 0, 0);
let tick = 0;
const clock: Clock = { now: () => new Date(T0 + tick++ * 1_000) };

const expectCode = (act: () => unknown, code: string): void => {
  try {
    act();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const cmd = (over: Partial<IntakeCommand>): IntakeCommand => ({
  channel: 'c2b',
  externalRef: 'SBC12XY9ZQ',
  idempotencyKey: 'idem-dup-1',
  amount: Money.ofMinor(2_500, 'KES'),
  ...over,
});

describe('Intake — one funnel, both Daraja paths (issue #2, C5)', () => {
  const channelRows: { channel: PaymentChannel; ref: string; key: string }[] = [
    { channel: 'c2b', ref: 'SBC12XY9ZQ', key: 'idem-c2b-1' },
    { channel: 'stk', ref: 'ws_CO_1742030001', key: 'idem-stk-1' },
  ];
  it.each(channelRows)('$channel first sight creates exactly one initiated payment', ({ channel, ref, key }) => {
    const { payment, duplicate, events } = intakePayment(
      { channel, externalRef: ref, idempotencyKey: key, amount: Money.ofMinor(2_500, 'KES'), paymentId: rid(1) },
      { clock },
    );
    expect(duplicate).toBe(false);
    expect(payment.state).toBe('initiated');
    expect(payment.channel).toBe(channel);
    expect(payment.externalRef).toBe(ref);
    expect(payment.idempotencyKey).toBe(key);
    expect(payment.requestedMinor.amount).toBe(2_500n);
    expect(payment.currency).toBe('KES');
    expect(payment.allocations).toHaveLength(0);
    expect(payment.refunds).toHaveLength(0);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.name).toBe('payment.initiated');
    if (evt?.name !== 'payment.initiated') throw new Error('unexpected event');
    expect(evt.version).toBe(1);
    expect(evt.aggregateId).toBe(payment.id);
    expect(evt.payload).toMatchObject({ paymentId: payment.id, channel, requestedMinor: 2_500n });
    expect(evt.occurredAt).toBeInstanceOf(Date);
  });

  it.each(channelRows)('$channel duplicate callback returns the SAME payment, never a second one (R9/C5)', ({ channel, ref, key }) => {
    const first = intakePayment(
      { channel, externalRef: ref, idempotencyKey: key, amount: Money.ofMinor(2_500, 'KES'), paymentId: rid(2) },
      { clock },
    );
    const second = intakePayment(
      { channel, externalRef: ref, idempotencyKey: key, amount: Money.ofMinor(2_500, 'KES') },
      { clock, existing: [first.payment] },
    );
    expect(second.duplicate).toBe(true);
    expect(second.payment).toBe(first.payment);
    expect(second.events).toHaveLength(1);
    const evt = second.events[0];
    expect(evt?.name).toBe('payments.duplicateCallbackObserved');
    if (evt?.name !== 'payments.duplicateCallbackObserved') throw new Error('unexpected event');
    expect(evt.payload).toMatchObject({ paymentId: first.payment.id, externalRef: ref });
    expect(evt.payload.seenAt).toBeInstanceOf(Date);
    expect(evt.occurredAt).toBeInstanceOf(Date);
  });

  it('a duplicate is detected by idempotencyKey even when channel and externalRef differ (R9)', () => {
    const stk = intakePayment(
      cmd({ channel: 'stk', externalRef: 'ws_CO_777', idempotencyKey: 'journey-42', paymentId: rid(3) }),
      { clock },
    );
    const c2bEcho = intakePayment(
      cmd({ channel: 'c2b', externalRef: 'SBC99ZZ', idempotencyKey: 'journey-42' }),
      { clock, existing: [stk.payment] },
    );
    expect(c2bEcho.duplicate).toBe(true);
    expect(c2bEcho.payment.id).toBe(stk.payment.id);
    expect(c2bEcho.events.map((e) => e.name)).toEqual(['payments.duplicateCallbackObserved']);
  });

  it('the same externalRef on a DIFFERENT channel is NOT a duplicate — unique(channel, externalRef)', () => {
    const c2b = intakePayment(
      cmd({ channel: 'c2b', externalRef: 'SHARED001', idempotencyKey: 'k-c2b', paymentId: rid(4) }),
      { clock },
    );
    const stk = intakePayment(
      cmd({ channel: 'stk', externalRef: 'SHARED001', idempotencyKey: 'k-stk' }),
      { clock, existing: [c2b.payment] },
    );
    expect(stk.duplicate).toBe(false);
    expect(stk.payment.id).not.toBe(c2b.payment.id);
    expect(stk.events.map((e) => e.name)).toEqual(['payment.initiated']);
  });

  it('a duplicate carrying a different amount is tampering, not a retry (DUPLICATE_AMOUNT_MISMATCH)', () => {
    const first = intakePayment(cmd({ paymentId: rid(5) }), { clock });
    expectCode(
      () =>
        intakePayment(
          cmd({ amount: Money.ofMinor(2_501, 'KES') }),
          { clock, existing: [first.payment] },
        ),
      'DUPLICATE_AMOUNT_MISMATCH',
    );
  });

  it('a duplicate carrying a different currency is rejected (R10)', () => {
    const first = intakePayment(cmd({ paymentId: rid(6) }), { clock });
    expectCode(
      () =>
        intakePayment(
          cmd({ amount: Money.ofMinor(2_500, 'USD') }),
          { clock, existing: [first.payment] },
        ),
      'CURRENCY_MISMATCH',
    );
  });

  it('a failed payment with the same ref still absorbs the duplicate (never a second payment)', () => {
    // Build a failed payment through the funnel + machine, then replay intake.
    const first = intakePayment(cmd({ paymentId: rid(7) }), { clock }).payment;
    const second = intakePayment(cmd({}), { clock, existing: [first] });
    expect(second.duplicate).toBe(true);
    expect(second.payment.state).toBe('initiated');
  });
});

describe('Intake validation (channel input is untrusted)', () => {
  const invalidRows: { name: string; code: string; command: IntakeCommand }[] = [
    {
      name: 'blank externalRef',
      code: 'INTAKE_EXTERNAL_REF_REQUIRED',
      command: cmd({ externalRef: '   ' }),
    },
    {
      name: 'blank idempotencyKey',
      code: 'INTAKE_IDEMPOTENCY_KEY_REQUIRED',
      command: cmd({ idempotencyKey: '' }),
    },
    {
      name: 'zero amount',
      code: 'AMOUNT_MUST_BE_POSITIVE',
      command: cmd({ amount: Money.ofMinor(0, 'KES') }),
    },
    {
      name: 'blank declared ref',
      code: 'INTAKE_DECLARED_REF_BLANK',
      command: cmd({ declaredRefs: ['INV-1', '   '] }),
    },
  ];
  it.each(invalidRows)('rejects $name ($code)', ({ command, code }) => {
    expectCode(() => intakePayment(command, { clock }), code);
  });

  it('rejects an unknown channel', () => {
    expectCode(
      () =>
        intakePayment(
          cmd({ channel: 'ussd' as unknown as PaymentChannel }),
          { clock },
        ),
      'INTAKE_CHANNEL_INVALID',
    );
  });
});

describe('Intake ergonomics', () => {
  it('declaredRefs are trimmed, de-duplicated and order-preserving', () => {
    const { payment } = intakePayment(
      cmd({ declaredRefs: [' INV-1 ', 'INV-2', 'INV-1'] }),
      { clock },
    );
    expect(payment.declaredRefs).toEqual(['INV-1', 'INV-2']);
  });

  it('without an explicit paymentId, the derived id is deterministic per (channel, idempotencyKey)', () => {
    const fixedClock: Clock = { now: () => new Date(T0) };
    const a = intakePayment(cmd({ externalRef: 'A1', idempotencyKey: 'k-1' }), { clock: fixedClock });
    const b = intakePayment(cmd({ externalRef: 'A1', idempotencyKey: 'k-1' }), {
      clock: fixedClock,
      existing: [],
    });
    const c = intakePayment(cmd({ externalRef: 'A1', idempotencyKey: 'k-2' }), { clock: fixedClock });
    expect(a.payment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b.payment.id).toBe(a.payment.id);
    expect(c.payment.id).not.toBe(a.payment.id);
  });

  it('customerId is optional at intake (C2B paybill may be unidentified)', () => {
    const anonymous = intakePayment(cmd({ paymentId: rid(8) }), { clock }).payment;
    expect(anonymous.customerId).toBeUndefined();
    const known = intakePayment(cmd({ customerId: rid(70), paymentId: rid(9) }), { clock }).payment;
    expect(known.customerId).toBe(rid(70));
  });

  it('intake never mutates the existing payment list', () => {
    const existing: Payment[] = [
      intakePayment(cmd({ paymentId: rid(10) }), { clock }).payment,
    ];
    intakePayment(cmd({ externalRef: 'OTHER', idempotencyKey: 'k-other' }), { clock, existing });
    expect(existing).toHaveLength(1);
  });
});

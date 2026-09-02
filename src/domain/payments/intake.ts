/**
 * Intake — ONE creation funnel for both Daraja paths (issue #2, finding C5).
 *
 * C2B callbacks and STK push results converge here; there is no second funnel
 * to race. Daraja is at-least-once (K1): duplicate callbacks are NORMAL, and
 * intake is idempotent by construction —
 *   unique(channel, externalRef)  OR  unique(idempotencyKey)   (R9, C5)
 * A duplicate returns the EXISTING Payment and emits
 * `payments.duplicateCallbackObserved` (E15, the C5 tripwire for ops) — it
 * never creates a second Payment.
 *
 * Pure function: time from the injected Clock, ids from the caller
 * (cmd.paymentId, preferred) or derived deterministically from
 * (channel, idempotencyKey) so replays of the same logical command coincide.
 */
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import { duplicateCallbackObservedEvent, paymentInitiatedEvent } from './events';
import type { PaymentEvent } from './events';
import { uuidFromSeed } from './ids';
import type { Payment, PaymentChannel } from './payment';

export interface IntakeCommand {
  readonly channel: PaymentChannel;
  readonly externalRef: string; // Daraja transaction id
  readonly idempotencyKey: string; // ties the whole payment journey together
  readonly amount: Money; // requestedMinor — Money, minor units (R10)
  readonly customerId?: Uuid; // known for STK; often unknown for C2B paybill
  readonly declaredRefs?: readonly string[]; // payer-typed invoice/receipt refs
  readonly paymentId?: Uuid; // caller-supplied id (preferred); deterministic fallback otherwise
}

export interface IntakeContext {
  readonly clock: Clock;
  readonly existing?: readonly Payment[]; // payments already known to this process
}

export interface IntakeResult {
  readonly payment: Payment;
  readonly duplicate: boolean;
  readonly events: readonly PaymentEvent[];
}

const trimmed = (raw: string): string => raw.trim();

const normalizeDeclaredRefs = (refs: readonly string[] | undefined): readonly string[] => {
  if (!refs || refs.length === 0) return [];
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) {
      throw new DomainError('INTAKE_DECLARED_REF_BLANK', 'declared references cannot be blank');
    }
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
};

export const intakePayment = (cmd: IntakeCommand, ctx: IntakeContext): IntakeResult => {
  if (cmd.channel !== 'c2b' && cmd.channel !== 'stk') {
    throw new DomainError('INTAKE_CHANNEL_INVALID', `unknown channel: ${String(cmd.channel)}`);
  }
  const externalRef = trimmed(cmd.externalRef);
  if (!externalRef) {
    throw new DomainError('INTAKE_EXTERNAL_REF_REQUIRED', 'externalRef (Daraja transaction id) is required');
  }
  const idempotencyKey = trimmed(cmd.idempotencyKey);
  if (!idempotencyKey) {
    throw new DomainError('INTAKE_IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required (R9)');
  }
  if (cmd.amount.amount <= 0n) {
    throw new DomainError('AMOUNT_MUST_BE_POSITIVE', 'intake amounts must be > 0');
  }
  const declaredRefs = normalizeDeclaredRefs(cmd.declaredRefs);

  // R9/C5: a duplicate is the SAME logical payment — return it, never re-create.
  const prior = (ctx.existing ?? []).find(
    (p) =>
      (p.channel === cmd.channel && p.externalRef === externalRef) ||
      p.idempotencyKey === idempotencyKey,
  );
  if (prior) {
    if (prior.currency !== cmd.amount.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `payment ${prior.id} is ${prior.currency}; duplicate callback arrived as ${cmd.amount.currency} (R10)`,
      );
    }
    if (!prior.requestedMinor.equals(cmd.amount)) {
      // Same transaction id must mean the same money — anything else is
      // tampered/untrusted input, not a benign duplicate (K1 covers retries).
      throw new DomainError(
        'DUPLICATE_AMOUNT_MISMATCH',
        `duplicate callback for ${prior.externalRef} carries ${cmd.amount.toString()} but the payment was initiated for ${prior.requestedMinor.toString()}`,
      );
    }
    return {
      payment: prior,
      duplicate: true,
      events: [
        duplicateCallbackObservedEvent(
          { paymentId: prior.id, externalRef: prior.externalRef, seenAt: ctx.clock.now() },
          ctx.clock,
        ),
      ],
    };
  }

  const id =
    cmd.paymentId ?? uuidFromSeed(`payment:${cmd.channel}:${idempotencyKey}`);
  const payment: Payment = {
    id,
    channel: cmd.channel,
    externalRef,
    idempotencyKey,
    customerId: cmd.customerId,
    state: 'initiated',
    currency: cmd.amount.currency,
    requestedMinor: cmd.amount,
    declaredRefs,
    initiatedAt: ctx.clock.now(),
    allocations: [],
    refunds: [],
  };
  return {
    payment,
    duplicate: false,
    events: [
      paymentInitiatedEvent(
        { paymentId: id, channel: cmd.channel, requestedMinor: cmd.amount },
        ctx.clock,
      ),
    ],
  };
};

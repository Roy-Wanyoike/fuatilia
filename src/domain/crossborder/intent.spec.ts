import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { registerCorridor, suspendCorridor, type Corridor } from './corridor';
import {
  authorizeIntent,
  cancelIntent,
  draftIntent,
  expireIfDue,
  failIntent,
  settleIntent,
  submitIntent,
  type SubmissionRecord,
  type TransferIntent,
} from './intent';
import { attachQuote, INTENT_TRANSITIONS } from './intent';
import { quote, type FxQuote, type RateRowInput } from './quote';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(801);
const CORRIDOR = uid(803);
const ROW = uid(810);

const T0 = '2026-03-01T09:00:00.000Z'; // quote issued here, TTL 120s → expires 09:02
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const corridorOf = (overrides: Record<string, unknown> = {}): Corridor =>
  registerCorridor(
    {
      orgId: ORG,
      corridorId: CORRIDOR,
      sourceCurrency: 'KES' as const,
      destinationCurrency: 'TZS' as const,
      minAmountMinor: 10_000,
      maxAmountMinor: 10_000_000,
      rails: ['mpesa_ke_tz', 'bank_swift'],
      feeSchedule: { flatMinor: 50n, bps: 150 },
      ...overrides,
    },
    at(T0),
  ).corridor;

const rowOf = (): RateRowInput => ({
  rowId: ROW,
  sourceCurrency: 'KES',
  destinationCurrency: 'TZS',
  numerator: 1935n,
  denominator: 100n,
  effectiveFrom: '2026-03-01T00:00:00.000Z',
  effectiveTo: null,
  source: 'CBK',
});

const corridor = corridorOf();
const AMOUNT = 10_000n;

const quoteAt = (clockIso = T0): FxQuote =>
  quote([corridor], CORRIDOR, AMOUNT, [rowOf()], at(clockIso)).quote;

const draftedAt = (clockIso = T0): TransferIntent =>
  draftIntent([corridor], CORRIDOR, { orgId: ORG, sourceCurrency: 'KES', destinationCurrency: 'TZS', sourceAmountMinor: AMOUNT }, at(clockIso)).intent;

const quotedAt = (clockIso = T0): TransferIntent => {
  const q = quoteAt(clockIso);
  return attachQuote(draftedAt(clockIso), q, at(clockIso)).intent;
};

const authorizedAt = (clockIso = '2026-03-01T09:00:30.000Z'): TransferIntent =>
  authorizeIntent(quotedAt(T0), { authorizedBy: 'treasury-desk' }, at(clockIso)).intent;

const submittedAt = (clockIso = '2026-03-01T09:00:40.000Z'): { intent: TransferIntent; submission: SubmissionRecord } => {
  const intent = authorizedAt();
  const result = submitIntent(
    intent,
    { idempotencyKey: 'submit-001', rail: 'mpesa_ke_tz' },
    { clock: at(clockIso), corridor },
  );
  return { intent: result.intent, submission: result.submission };
};

// --- lifecycle table ---------------------------------------------------------------

describe('INTENT_TRANSITIONS — the one table that governs the lifecycle', () => {
  it('encodes the deliberately illegal shortcuts', () => {
    expect(INTENT_TRANSITIONS.drafted).toEqual(['quoted', 'cancelled']);
    expect(INTENT_TRANSITIONS.quoted).toEqual(['authorized', 'cancelled', 'expired']);
    expect(INTENT_TRANSITIONS.authorized).toEqual(['submitted', 'cancelled', 'expired']);
    expect(INTENT_TRANSITIONS.submitted).toEqual(['settled', 'failed', 'cancelled']);
    for (const terminal of ['settled', 'cancelled', 'expired', 'failed'] as const) {
      expect(INTENT_TRANSITIONS[terminal]).toEqual([]);
    }
    // no skipping quoted; no expiry out of drafted/submitted
    expect(INTENT_TRANSITIONS.drafted).not.toContain('authorized');
    expect(INTENT_TRANSITIONS.drafted).not.toContain('expired');
    expect(INTENT_TRANSITIONS.submitted).not.toContain('expired');
  });
});

// --- draft --------------------------------------------------------------------------

describe('draftIntent', () => {
  it('drafts a pre-authorization posture: status drafted, zero events', () => {
    const { intent, events } = draftIntent(
      [corridor],
      CORRIDOR,
      { orgId: ORG, sourceCurrency: 'KES', destinationCurrency: 'TZS', sourceAmountMinor: AMOUNT },
      at(T0),
    );
    expect(intent.status).toBe('drafted');
    expect(intent.quote).toBeNull();
    expect(intent.createdAt).toBe(T0);
    expect(events).toEqual([]);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('refusal table', () => {
    const args = { orgId: ORG, sourceCurrency: 'KES' as const, destinationCurrency: 'TZS' as const, sourceAmountMinor: AMOUNT };
    expectCode(() => draftIntent([corridor], uid(899), args, at(T0)), 'CORRIDOR_UNKNOWN');
    expectCode(
      () => draftIntent([corridor], CORRIDOR, { ...args, sourceCurrency: 'TZS', destinationCurrency: 'KES' }, at(T0)),
      'CURRENCY_MISMATCH',
    );
    expectCode(
      () => draftIntent([corridor], CORRIDOR, { ...args, sourceCurrency: 'XXX' as unknown as 'KES', destinationCurrency: 'TZS' }, at(T0)),
      'CURRENCY_UNSUPPORTED',
    );
    expectCode(
      () => draftIntent([corridor], CORRIDOR, { ...args, sourceAmountMinor: 9_999n }, at(T0)),
      'AMOUNT_OUT_OF_BOUNDS',
    );
    expectCode(
      () => draftIntent([corridor], CORRIDOR, { ...args, sourceAmountMinor: -1n }, at(T0)),
      'MONEY_NEGATIVE',
    );
    expectCode(
      () =>
        draftIntent(
          [suspendCorridor(corridor, 'compliance hold', at(T0)).corridor],
          CORRIDOR,
          args,
          at(T0),
        ),
      'CORRIDOR_SUSPENDED',
    );
  });
});

// --- quote attach ---------------------------------------------------------------------

describe('attachQuote — the freeze boundary (drafted → quoted)', () => {
  it('freezes the quote into the intent; the frozen parts are immutable thereafter', () => {
    const q = quoteAt(T0);
    const { intent } = attachQuote(draftedAt(), q, at(T0));
    expect(intent.status).toBe('quoted');
    expect(intent.quote?.quoteId).toBe(q.quoteId);
    expect(intent.quote?.sourceDebitMinor).toBe(10_200n);
    expect(intent.quote?.destinationCreditMinor).toBe(193_500n);
    expect(intent.quotedAt).toBe(T0);
    expect(Object.isFrozen(intent)).toBe(true);
    // tamper with the live quote AFTER attach — the frozen copy is unaffected
    const drifted: FxQuote = { ...q, destinationCreditMinor: 999n };
    expect(intent.quote?.destinationCreditMinor).toBe(193_500n);
    expect(drifted.quoteId).toBe(q.quoteId);
  });

  it('mismatch table', () => {
    const q = quoteAt(T0);
    const drafted = draftedAt();
    expectCode(() => attachQuote(quotedAt(), q, at(T0)), 'INTENT_STATE_INVALID'); // re-attach
    expectCode(
      () => attachQuote({ ...drafted, orgId: uid(899) }, q, at(T0)),
      'QUOTE_ORG_MISMATCH',
    );
    expectCode(
      () => attachQuote({ ...drafted, corridorId: uid(898) }, q, at(T0)),
      'QUOTE_CORRIDOR_MISMATCH',
    );
    expectCode(
      () => attachQuote({ ...drafted, sourceAmountMinor: 20_000n }, q, at(T0)),
      'QUOTE_AMOUNT_MISMATCH',
    );
    expectCode(
      () => attachQuote({ ...drafted, sourceCurrency: 'TZS', destinationCurrency: 'KES' }, q, at(T0)),
      'CURRENCY_MISMATCH',
    );
  });

  it('expiry at the freeze boundary: 1ms before attaches, at the instant refuses', () => {
    const q = quoteAt(T0); // expires 09:02
    expect(() => attachQuote(draftedAt(), q, at('2026-03-01T09:01:59.999Z'))).not.toThrow();
    expectCode(() => attachQuote(draftedAt(), q, at('2026-03-01T09:02:00.000Z')), 'QUOTE_EXPIRED');
  });
});

// --- authorize ------------------------------------------------------------------------

describe('authorizeIntent (quoted → authorized)', () => {
  it('authorizes with the FROZEN fee + rate in the event — the audit proof of what settles', () => {
    const { intent, events } = authorizeIntent(quotedAt(), { authorizedBy: 'treasury-desk' }, at('2026-03-01T09:00:30.000Z'));
    expect(intent.status).toBe('authorized');
    expect(intent.authorizedBy).toBe('treasury-desk');
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('crossborder.intentAuthorized');
    const payload = events[0]!.payload as unknown as Record<string, unknown>;
    expect(payload.sourceDebitMinor).toBe(10_200);
    expect(payload.destinationCreditMinor).toBe(193_500);
    expect(payload.fee).toEqual({ flatMinor: 50, bpsMinor: 150, totalMinor: 200, bps: 150 });
  });

  it('refusal table', () => {
    expectCode(() => authorizeIntent(draftedAt(), { authorizedBy: 'x' }, at(T0)), 'INTENT_STATE_INVALID'); // skipping quoted
    expectCode(() => authorizeIntent(quotedAt(), { authorizedBy: '   ' }, at(T0)), 'INTENT_ACTOR_REQUIRED');
    // a quote that expires between attach and authorize refuses authorization
    const q = quoteAt(T0);
    const quoted = attachQuote(draftedAt(), q, at(T0)).intent;
    expectCode(() => authorizeIntent(quoted, { authorizedBy: 'desk' }, at('2026-03-01T09:02:00.000Z')), 'QUOTE_EXPIRED');
  });
});

// --- submit ----------------------------------------------------------------------------

describe('submitIntent — idempotent submission (R9/C5)', () => {
  it('submits an authorized intent: rail frozen, submission recorded, event emitted', () => {
    const intent = authorizedAt();
    const { intent: submitted, submission, duplicate, events } = submitIntent(
      intent,
      { idempotencyKey: 'submit-001', rail: 'mpesa_ke_tz' },
      { clock: at('2026-03-01T09:00:40.000Z'), corridor },
    );
    expect(duplicate).toBe(false);
    expect(submitted.status).toBe('submitted');
    expect(submitted.rail).toBe('mpesa_ke_tz');
    expect(submission.idempotencyKey).toBe('submit-001');
    expect(submission.rail).toBe('mpesa_ke_tz');
    expect(events[0]!.name).toBe('crossborder.intentSubmitted');
  });

  it('refusal table', () => {
    const intent = authorizedAt();
    expectCode(
      () => submitIntent(intent, { idempotencyKey: '   ', rail: 'mpesa_ke_tz' }, { clock: at(T0), corridor }),
      'INTENT_IDEMPOTENCY_KEY_REQUIRED',
    );
    expectCode(
      () => submitIntent(quotedAt(), { idempotencyKey: 'k', rail: 'mpesa_ke_tz' }, { clock: at(T0), corridor }),
      'INTENT_STATE_INVALID',
    ); // must authorize first
    expectCode(
      () => submitIntent(intent, { idempotencyKey: 'k', rail: 'carrier_pigeon' }, { clock: at(T0), corridor }),
      'INTENT_RAIL_INVALID',
    );
    expectCode(
      () =>
        submitIntent(intent, { idempotencyKey: 'k', rail: 'mpesa_ke_tz' }, {
          clock: at(T0),
          corridor: suspendCorridor(corridor, 'down', at(T0)).corridor,
        }),
      'CORRIDOR_SUSPENDED',
    );
  });

  it('an identical retry replays the ORIGINAL outcome + intentReplayObserved (never re-processes)', () => {
    const first = submittedAt();
    const replay = submitIntent(
      authorizedAt(),
      { idempotencyKey: 'submit-001', rail: 'mpesa_ke_tz' },
      { clock: at('2026-03-01T09:01:00.000Z'), corridor, submissions: [first.submission] },
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.submission).toBe(first.submission);
    expect(replay.intent.status).toBe('authorized'); // duplicates leave the intent untouched
    expect(replay.events[0]!.name).toBe('crossborder.intentReplayObserved');
  });

  it('a CONFLICTING retry under the same key is refused (INTENT_DUPLICATE_SUBMIT)', () => {
    const first = submittedAt();
    expectCode(
      () =>
        submitIntent(
          authorizedAt(),
          { idempotencyKey: 'submit-001', rail: 'bank_swift' }, // different rail, same key
          { clock: at('2026-03-01T09:01:00.000Z'), corridor, submissions: [first.submission] },
        ),
      'INTENT_DUPLICATE_SUBMIT',
    );
  });
});

// --- settle ------------------------------------------------------------------------------

describe('settleIntent — the frozen quote governs settlement', () => {
  it('settles on the frozen legs and emits intentSettled referencing the quote (rate audit)', () => {
    const { intent } = submittedAt();
    const { intent: settled, events } = settleIntent(intent, {
      clock: at('2026-03-01T09:05:00.000Z'),
      settlementRef: 'RAIL-REF-77',
    });
    expect(settled.status).toBe('settled');
    expect(settled.settledAt).toBe('2026-03-01T09:05:00.000Z');
    expect(settled.settlementRef).toBe('RAIL-REF-77');
    expect(events[0]!.name).toBe('crossborder.intentSettled');
    const payload = events[0]!.payload as unknown as Record<string, unknown>;
    expect(payload.quoteId).toBe(intent.quote?.quoteId);
    expect(payload.sourceDebitMinor).toBe(10_200);
    expect(payload.destinationCreditMinor).toBe(193_500);
  });

  it('realized legs must reconcile exactly — no cent created or destroyed (R1/R2)', () => {
    const { intent } = submittedAt();
    expectCode(
      () => settleIntent(intent, { clock: at(T0), realizedSourceDebitMinor: 10_201n }),
      'INTENT_SETTLEMENT_MISMATCH',
    );
    expectCode(
      () => settleIntent(intent, { clock: at(T0), realizedDestinationCreditMinor: 193_499n }),
      'INTENT_SETTLEMENT_MISMATCH',
    );
    expect(() =>
      settleIntent(intent, {
        clock: at(T0),
        realizedSourceDebitMinor: 10_200n,
        realizedDestinationCreditMinor: 193_500n,
      }),
    ).not.toThrow();
  });

  it('a corridor fee-schedule drift since authorization is refused, never silently absorbed', () => {
    const { intent } = submittedAt();
    const repriced = corridorOf({ feeSchedule: { flatMinor: 500n, bps: 150 } });
    expectCode(() => settleIntent(intent, { clock: at(T0), corridor: repriced }), 'FEE_SCHEDULE_CHANGED');
    // an unchanged schedule still settles with the check in place
    expect(() => settleIntent(intent, { clock: at(T0), corridor })).not.toThrow();
  });

  it('only submitted intents settle', () => {
    expectCode(() => settleIntent(authorizedAt(), { clock: at(T0) }), 'INTENT_STATE_INVALID');
  });
});

// --- cancel / fail / expire -----------------------------------------------------------

describe('cancel / fail / expire — the exits', () => {
  it('cancel takes reason + actor from any cancellable state', () => {
    const { intent, events } = cancelIntent(draftedAt(), { reason: 'changed mind', actorId: 'ops-1' }, at(T0));
    expect(intent.status).toBe('cancelled');
    expect(intent.cancelledAt).toBe(T0);
    expect(events[0]!.name).toBe('crossborder.intentCancelled');
    expectCode(() => cancelIntent(draftedAt(), { reason: '  ', actorId: 'ops-1' }, at(T0)), 'INTENT_REASON_REQUIRED');
    expectCode(() => cancelIntent(draftedAt(), { reason: 'x', actorId: ' ' }, at(T0)), 'INTENT_ACTOR_REQUIRED');
  });

  it('cancel is illegal from terminal states', () => {
    const { intent } = submittedAt();
    const settled = settleIntent(intent, { clock: at(T0) }).intent;
    expectCode(() => cancelIntent(settled, { reason: 'undo', actorId: 'ops' }, at(T0)), 'INTENT_STATE_INVALID');
  });

  it('fail is a post-submit rail outcome only', () => {
    const { intent } = submittedAt();
    const { intent: failed, events } = failIntent(intent, { reason: 'rail timeout' }, at(T0));
    expect(failed.status).toBe('failed');
    expect(events[0]!.name).toBe('crossborder.intentFailed');
    expectCode(() => failIntent(draftedAt(), { reason: 'x' }, at(T0)), 'INTENT_STATE_INVALID');
  });

  it('expireIfDue: quoted intents flip silently at the frozen expiry; before/drafted/submitted never', () => {
    const quoted = quotedAt(T0); // expires 09:02
    const before = expireIfDue(quoted, at('2026-03-01T09:01:59.999Z'));
    expect(before.intent.status).toBe('quoted');
    expect(before.events).toEqual([]);
    const due = expireIfDue(quoted, at('2026-03-01T09:02:00.000Z'));
    expect(due.intent.status).toBe('expired');
    expect(due.intent.expiredAt).toBe('2026-03-01T09:02:00.000Z');
    expect(due.events).toEqual([]); // silent flip — no catalog event by design

    expect(expireIfDue(draftedAt(), at('2026-03-01T09:05:00.000Z')).intent.status).toBe('drafted');
    const inFlight = submittedAt().intent; // submitted at 09:00:40, quote expires 09:02
    expect(expireIfDue(inFlight, at('2026-03-01T09:03:00.000Z')).intent.status).toBe('submitted'); // rate locked
  });
});

// --- the full walk -------------------------------------------------------------------------

describe('full lifecycle walk — every event in order, no cent created or destroyed', () => {
  it('draft → attach → authorize → submit → settle emits exactly the audit chain', () => {
    const q = quoteAt(T0);
    const d = draftedAt();
    const quoted = attachQuote(d, q, at(T0)).intent;
    const { intent: authorized, events: authEvents } = authorizeIntent(quoted, { authorizedBy: 'desk' }, at('2026-03-01T09:00:30.000Z'));

    const { intent: submitted, submission, events: subEvents } = submitIntent(
      authorized,
      { idempotencyKey: 'walk-1', rail: 'bank_swift' },
      { clock: at('2026-03-01T09:00:40.000Z'), corridor },
    );
    const { intent: settled, events: setEvents } = settleIntent(submitted, {
      clock: at('2026-03-01T09:06:00.000Z'),
      realizedSourceDebitMinor: submission.sourceDebitMinor,
      realizedDestinationCreditMinor: submission.destinationCreditMinor,
      settlementRef: 'RAIL-9',
    });

    expect(settled.status).toBe('settled');
    expect(authEvents.map((e) => e.name)).toEqual(['crossborder.intentAuthorized']);
    expect(subEvents.map((e) => e.name)).toEqual(['crossborder.intentSubmitted']);
    expect(setEvents.map((e) => e.name)).toEqual(['crossborder.intentSettled']);
    // the frozen quote's arithmetic survives the whole journey
    expect(submission.sourceDebitMinor).toBe(10_200n);
    expect(submission.destinationCreditMinor).toBe(193_500n);
    expect(settled.quote?.quoteId).toBe(q.quoteId);
  });

  it('the input intent is never mutated by any transition (no-mutation pin)', () => {
    const d = draftedAt();
    const q = quoteAt(T0);
    attachQuote(d, q, at(T0));
    expect(d.status).toBe('drafted');
    expect(d.quote).toBeNull();
  });
});

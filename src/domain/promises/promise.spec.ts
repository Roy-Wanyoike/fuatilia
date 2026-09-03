import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  PROMISE_EXPIRY_GRACE_DAYS,
  PROMISE_TRANSITIONS,
  applySettlement,
  createPromise,
  expirePromise,
  markPromiseBroken,
  remainingMinor,
  transitionPromise,
  type PromiseStatus,
  type PromiseToPay,
} from './promise';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(601);
const CUSTOMER = uid(602);
const RECEIVABLE_A = uid(611);
const RECEIVABLE_B = uid(612);
const PROMISE = uid(620);

const T0 = '2026-03-01T09:00:00.000Z';
const PROMISED = '2026-03-10T00:00:00.000Z';
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

const baseArgs = (overrides: Partial<Parameters<typeof createPromise>[0]> = {}) => ({
  promiseId: PROMISE,
  orgId: ORG,
  customerId: CUSTOMER,
  receivableIds: [RECEIVABLE_A, RECEIVABLE_B],
  amountMinor: 50_000,
  currency: 'KES' as const,
  promisedDate: new Date(PROMISED),
  source: 'whatsapp',
  ...overrides,
});

/** A promise activated at T0 (status `pending`). */
const pendingPromise = (): PromiseToPay =>
  transitionPromise(
    createPromise(baseArgs(), at(T0)).promise,
    'pending',
    { reason: 'reminder cadence started', actorId: 'system' },
    at(T0),
  ).promise;

/** Drive a real promise to any state through legal paths only. */
const promiseIn = (status: PromiseStatus): PromiseToPay => {
  const created = createPromise(baseArgs(), at(T0)).promise;
  switch (status) {
    case 'created':
      return created;
    case 'pending':
      return pendingPromise();
    case 'partially_fulfilled':
      return applySettlement(pendingPromise(), 20_000, at('2026-03-05T10:00:00.000Z')).promise;
    case 'fulfilled':
      return applySettlement(pendingPromise(), 50_000, at('2026-03-05T10:00:00.000Z')).promise;
    case 'broken':
      return markPromiseBroken(
        pendingPromise(),
        { reason: 'no payment by promised date' },
        at('2026-03-13T10:00:00.000Z'),
      ).promise;
    case 'cancelled':
      return transitionPromise(
        created,
        'cancelled',
        { reason: 'withdrawn', actorId: 'agent-1' },
        at(T0),
      ).promise;
    case 'expired':
      return expirePromise(created, at('2026-03-18T00:00:00.000Z')).promise;
  }
};

// --- the transition table -------------------------------------------------------

describe('PROMISE_TRANSITIONS — the SPEC §10 table', () => {
  it('has a row for every status and only known targets', () => {
    const statuses: PromiseStatus[] = [
      'created',
      'pending',
      'partially_fulfilled',
      'fulfilled',
      'broken',
      'cancelled',
      'expired',
    ];
    for (const from of statuses) {
      expect(PROMISE_TRANSITIONS[from]).toBeDefined();
      for (const to of PROMISE_TRANSITIONS[from]) {
        expect(statuses).toContain(to);
      }
    }
  });

  it('leaves every terminal state empty (table)', () => {
    const table: Array<[PromiseStatus, boolean]> = [
      ['fulfilled', true],
      ['broken', true],
      ['cancelled', true],
      ['expired', true],
      ['created', false],
      ['pending', false],
      ['partially_fulfilled', false],
    ];
    for (const [status, terminal] of table) {
      expect(PROMISE_TRANSITIONS[status].length === 0).toBe(terminal);
    }
  });
});

// --- creation --------------------------------------------------------------------

describe('createPromise — recording the commitment (promise.created)', () => {
  it('records the promise in state created with every field intact', () => {
    const { promise, event } = createPromise(baseArgs({ consentRef: 'consent-123' }), at(T0));
    expect(promise.status).toBe('created');
    expect(promise.amountMinor).toBe(50_000);
    expect(promise.currency).toBe('KES');
    expect(promise.source).toBe('whatsapp');
    expect(promise.consentRef).toBe('consent-123');
    expect(promise.settledMinor).toBe(0);
    expect(promise.receivableIds).toEqual([RECEIVABLE_A, RECEIVABLE_B]);
    expect(promise.promisedDate.toISOString()).toBe(PROMISED);
    expect(event.name).toBe('promise.created');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(PROMISE);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toMatchObject({
      promiseId: PROMISE,
      orgId: ORG,
      customerId: CUSTOMER,
      amountMinor: 50_000,
      source: 'whatsapp',
      consentRef: 'consent-123',
    });
  });

  it('defaults consentRef to null when the promise arrived without one', () => {
    const { promise } = createPromise(baseArgs(), at(T0));
    expect(promise.consentRef).toBeNull();
  });

  it('refuses malformed promises (table)', () => {
    const table: Array<[Partial<Parameters<typeof createPromise>[0]>, string]> = [
      [{ amountMinor: 0 }, 'PROMISE_AMOUNT_INVALID'],
      [{ amountMinor: -5 }, 'PROMISE_AMOUNT_INVALID'],
      [{ amountMinor: 10.5 }, 'PROMISE_AMOUNT_INVALID'],
      [{ amountMinor: Number.MAX_SAFE_INTEGER + 1 }, 'PROMISE_AMOUNT_INVALID'],
      [{ source: 'email' }, 'PROMISE_SOURCE_INVALID'],
      [{ receivableIds: [] }, 'PROMISE_RECEIVABLES_REQUIRED'],
      [{ receivableIds: [RECEIVABLE_A, RECEIVABLE_A] }, 'PROMISE_RECEIVABLE_DUPLICATE'],
      [{ promisedDate: new Date('nope') }, 'PROMISE_PROMISED_DATE_INVALID'],
      [{ consentRef: '   ' }, 'PROMISE_CONSENT_REF_INVALID'],
    ];
    for (const [overrides, code] of table) {
      expectCode(() => createPromise(baseArgs(overrides), at(T0)), code);
    }
  });
});

// --- the generic table-driven transition (full 7×7 grid) ----------------------------

describe('transitionPromise — the full legal/illegal grid', () => {
  const statuses: PromiseStatus[] = [
    'created',
    'pending',
    'partially_fulfilled',
    'fulfilled',
    'broken',
    'cancelled',
    'expired',
  ];

  const expectedFor = (from: PromiseStatus, to: PromiseStatus): string | 'ok' => {
    if (to === 'pending') return from === 'created' ? 'ok' : 'PROMISE_TRANSITION_INVALID';
    if (to === 'cancelled') {
      return ['created', 'pending', 'partially_fulfilled'].includes(from)
        ? 'ok'
        : 'PROMISE_TRANSITION_INVALID';
    }
    if (PROMISE_TRANSITIONS[from].includes(to)) return 'PROMISE_TRANSITION_NOT_AUTOMATIC';
    return 'PROMISE_TRANSITION_INVALID';
  };

  it('decides all 49 (from, to) pairs per the table', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const expected = expectedFor(from, to);
        try {
          const { promise } = transitionPromise(
            promiseIn(from),
            to,
            { reason: `grid ${from}→${to}`, actorId: 'agent-1' },
            at('2026-03-02T10:00:00.000Z'),
          );
          expect(expected, `${from}→${to}`).toBe('ok');
          expect(promise.status, `${from}→${to}`).toBe(to);
        } catch (error) {
          expect(expected, `${from}→${to}`).not.toBe('ok');
          expect((error as DomainError).code, `${from}→${to}`).toBe(expected);
        }
      }
    }
  });

  it('refuses unknown statuses outright', () => {
    expectCode(
      () =>
        transitionPromise(
          promiseIn('created'),
          'settled' as PromiseStatus,
          { reason: 'typo', actorId: 'agent-1' },
          at(T0),
        ),
      'PROMISE_STATUS_INVALID',
    );
  });

  it('requires the reason + actor audit pair on every manual step (table)', () => {
    const table: Array<[string, string]> = [
      ['  ', 'PROMISE_REASON_REQUIRED'],
      ['', 'PROMISE_REASON_REQUIRED'],
    ];
    for (const [reason, code] of table) {
      expectCode(
        () =>
          transitionPromise(
            promiseIn('created'),
            'pending',
            { reason, actorId: 'agent-1' },
            at(T0),
          ),
        code,
      );
    }
    expectCode(
      () =>
        transitionPromise(
          promiseIn('created'),
          'pending',
          { reason: 'ok', actorId: ' ' },
          at(T0),
        ),
      'PROMISE_ACTOR_REQUIRED',
    );
  });

  it('activation stamps pendingAt and emits promise.activated', () => {
    const { promise, event } = transitionPromise(
      promiseIn('created'),
      'pending',
      { reason: 'tracking starts', actorId: 'system' },
      at('2026-03-01T12:00:00.000Z'),
    );
    expect(promise.status).toBe('pending');
    expect(promise.pendingAt?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(event.name).toBe('promise.activated');
    expect(event.occurredAt).toBe('2026-03-01T12:00:00.000Z');
    expect(event.payload).toMatchObject({
      promiseId: PROMISE,
      orgId: ORG,
      customerId: CUSTOMER,
      activatedAt: '2026-03-01T12:00:00.000Z',
    });
  });

  it('cancellation records reason + actor and is terminal', () => {
    const { promise, event } = transitionPromise(
      pendingPromise(),
      'cancelled',
      { reason: 'customer withdrew', actorId: 'agent-9' },
      at('2026-03-02T08:00:00.000Z'),
    );
    expect(promise.status).toBe('cancelled');
    expect(promise.cancelledAt?.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    expect(event.name).toBe('promise.cancelled');
    expect(event.payload).toMatchObject({ reason: 'customer withdrew', actorId: 'agent-9' });
    expectCode(
      () =>
        transitionPromise(
          promise,
          'pending',
          { reason: 'reopen', actorId: 'agent-9' },
          at(T0),
        ),
      'PROMISE_TRANSITION_INVALID',
    );
  });
});

// --- settlement-driven transitions ----------------------------------------------------

describe('applySettlement — coverage drives partially_fulfilled | fulfilled', () => {
  it('partial coverage lands in partially_fulfilled with exact totals', () => {
    const { promise, event } = applySettlement(
      pendingPromise(),
      20_000,
      at('2026-03-05T10:00:00.000Z'),
    );
    expect(promise.status).toBe('partially_fulfilled');
    expect(promise.settledMinor).toBe(20_000);
    expect(remainingMinor(promise)).toBe(30_000);
    expect(event.name).toBe('promise.partiallyFulfilled');
    expect(event.payload).toMatchObject({
      settledMinor: 20_000,
      totalSettledMinor: 20_000,
      remainingMinor: 30_000,
    });
  });

  it('accumulates partial settlements until the promise is fulfilled exactly', () => {
    let current = pendingPromise();
    const amounts = [10_000, 25_000, 15_000];
    amounts.forEach((amount, i) => {
      const { promise } = applySettlement(current, amount, at(`2026-03-0${i + 4}T10:00:00.000Z`));
      current = promise;
      expect(promise.settledMinor).toBe(amounts.slice(0, i + 1).reduce((a, b) => a + b, 0));
      expect(['partially_fulfilled', 'fulfilled']).toContain(promise.status);
    });
    expect(current.status).toBe('fulfilled');
    expect(current.fulfilledAt).not.toBeNull();
    expect(remainingMinor(current)).toBe(0);
  });

  it('a single full settlement fulfils directly (promise.fulfilled)', () => {
    const { promise, event } = applySettlement(
      pendingPromise(),
      50_000,
      at('2026-03-08T10:00:00.000Z'),
    );
    expect(promise.status).toBe('fulfilled');
    expect(event.name).toBe('promise.fulfilled');
    expect(event.payload).toMatchObject({
      amountMinor: 50_000,
      totalSettledMinor: 50_000,
      receivableIds: [RECEIVABLE_A, RECEIVABLE_B],
    });
  });

  it('refuses malformed and over-covering settlements (table)', () => {
    const table: Array<[number, string]> = [
      [0, 'PROMISE_SETTLEMENT_INVALID'],
      [-1, 'PROMISE_SETTLEMENT_INVALID'],
      [1.5, 'PROMISE_SETTLEMENT_INVALID'],
      [50_001, 'PROMISE_SETTLEMENT_EXCEEDS_PROMISED'],
      [100_000, 'PROMISE_SETTLEMENT_EXCEEDS_PROMISED'],
    ];
    for (const [amount, code] of table) {
      expectCode(() => applySettlement(pendingPromise(), amount, at(T0)), code);
    }
  });

  it('over-coverage leaves the aggregate untouched', () => {
    const before = pendingPromise();
    expectCode(
      () => applySettlement(before, 99_999, at(T0)),
      'PROMISE_SETTLEMENT_EXCEEDS_PROMISED',
    );
    expect(before.settledMinor).toBe(0);
    expect(before.status).toBe('pending');
  });

  it('settlements need an active promise (table)', () => {
    const table: Array<[PromiseStatus, string]> = [
      ['created', 'PROMISE_NOT_ACTIVE'],
      ['fulfilled', 'PROMISE_TRANSITION_INVALID'],
      ['broken', 'PROMISE_TRANSITION_INVALID'],
      ['cancelled', 'PROMISE_TRANSITION_INVALID'],
      ['expired', 'PROMISE_TRANSITION_INVALID'],
    ];
    for (const [status, code] of table) {
      expectCode(() => applySettlement(promiseIn(status), 100, at(T0)), code);
    }
  });

  it('a late settlement still fulfils the promise (past the promised date)', () => {
    const { promise } = applySettlement(pendingPromise(), 50_000, at('2026-03-12T10:00:00.000Z'));
    expect(promise.status).toBe('fulfilled');
  });
});

// --- breaking (SPEC §10 → collections workflow) --------------------------------------

describe('markPromiseBroken — past the promised date without coverage', () => {
  it('breaks with zero coverage and emits promise.broken + collections.promiseBroken', () => {
    const { promise, events } = markPromiseBroken(
      pendingPromise(),
      { reason: 'no payment by promised date', caseId: null },
      at('2026-03-13T10:00:00.000Z'),
    );
    expect(promise.status).toBe('broken');
    expect(promise.brokenAt?.toISOString()).toBe('2026-03-13T10:00:00.000Z');
    expect(promise.brokenReason).toBe('no payment by promised date');
    expect(events.map((e) => e.name)).toEqual(['promise.broken', 'collections.promiseBroken']);
    const [broken, trigger] = events;
    expect(broken!.payload).toMatchObject({
      promiseId: PROMISE,
      reason: 'no payment by promised date',
      expectedAt: PROMISED,
      settledMinor: 0,
    });
    // E27 shape: promiseId, caseId, expectedAt (+ who/what for intelligence)
    expect(trigger!.payload).toMatchObject({
      promiseId: PROMISE,
      caseId: null,
      expectedAt: PROMISED,
      customerId: CUSTOMER,
    });
  });

  it('breaks a partially covered promise too — shortfall is a break', () => {
    const partial = promiseIn('partially_fulfilled');
    const { promise } = markPromiseBroken(
      partial,
      { reason: 'partial only' },
      at('2026-03-13T10:00:00.000Z'),
    );
    expect(promise.status).toBe('broken');
    expect(promise.settledMinor).toBe(20_000);
  });

  it('carries the opaque collections caseId when one is open (E27)', () => {
    const CASE = uid(630);
    const { events } = markPromiseBroken(
      pendingPromise(),
      { reason: 'r', caseId: CASE },
      at('2026-03-13T10:00:00.000Z'),
    );
    expect(events[1]!.payload).toMatchObject({ caseId: CASE });
  });

  it('refuses premature or non-breaking breaks (table)', () => {
    const table: Array<[PromiseStatus, string, string]> = [
      ['created', '2026-03-13T10:00:00.000Z', 'PROMISE_NOT_ACTIVE'],
      ['fulfilled', '2026-03-13T10:00:00.000Z', 'PROMISE_TRANSITION_INVALID'],
      ['broken', '2026-03-13T10:00:00.000Z', 'PROMISE_TRANSITION_INVALID'],
      ['cancelled', '2026-03-13T10:00:00.000Z', 'PROMISE_TRANSITION_INVALID'],
      ['pending', '2026-03-10T00:00:00.000Z', 'PROMISE_NOT_DUE'],
      ['pending', '2026-03-05T10:00:00.000Z', 'PROMISE_NOT_DUE'],
    ];
    for (const [status, when, code] of table) {
      expectCode(
        () => markPromiseBroken(promiseIn(status), { reason: 'no payment' }, at(when)),
        code,
      );
    }
  });

  it('refuses to break a promise whose coverage already equals the promised amount', () => {
    // Defensive guard: adapters feed facts in — full coverage while still
    // active is corrupt data the lane must refuse, not silently break.
    const corrupted = { ...pendingPromise(), settledMinor: 50_000 };
    expectCode(
      () => markPromiseBroken(corrupted, { reason: 'oops' }, at('2026-03-13T10:00:00.000Z')),
      'PROMISE_ALREADY_FULFILLED',
    );
  });

  it('requires a break reason', () => {
    expectCode(
      () => markPromiseBroken(pendingPromise(), { reason: '  ' }, at('2026-03-13T10:00:00.000Z')),
      'PROMISE_REASON_REQUIRED',
    );
  });
});

// --- expiry (promised date + grace, never fulfilled) -----------------------------------

describe('expirePromise — the lapsed-promise path', () => {
  it('expires a never-fulfilled promise at the grace horizon (default 7 days)', () => {
    expect(PROMISE_EXPIRY_GRACE_DAYS).toBe(7);
    const { promise, event } = expirePromise(pendingPromise(), at('2026-03-17T00:00:00.000Z'));
    expect(promise.status).toBe('expired');
    expect(promise.expiredAt?.toISOString()).toBe('2026-03-17T00:00:00.000Z');
    expect(event.name).toBe('promise.expired');
    expect(event.payload).toMatchObject({ graceDays: 7, expectedAt: PROMISED });
  });

  it('expires a created (never activated) promise too', () => {
    const { promise } = expirePromise(promiseIn('created'), at('2026-03-18T00:00:00.000Z'));
    expect(promise.status).toBe('expired');
  });

  it('honours an injectable grace window (table)', () => {
    const table: Array<[string, number, string | 'ok']> = [
      ['2026-03-10T00:00:00.000Z', 0, 'ok'], // grace 0 → expires exactly on the promised date
      ['2026-03-09T23:59:59.999Z', 0, 'PROMISE_NOT_DUE'],
      ['2026-03-16T23:59:59.999Z', 7, 'PROMISE_NOT_DUE'],
      ['2026-03-17T00:00:00.000Z', 7, 'ok'],
      ['2026-04-01T00:00:00.000Z', 7, 'ok'],
    ];
    for (const [when, graceDays, expected] of table) {
      try {
        const { promise } = expirePromise(pendingPromise(), at(when), graceDays);
        expect(expected, `${when} grace=${graceDays}`).toBe('ok');
        expect(promise.status).toBe('expired');
      } catch (error) {
        expect(expected).not.toBe('ok');
        expect((error as DomainError).code).toBe(expected);
      }
    }
  });

  it('refuses malformed grace windows', () => {
    expectCode(
      () => expirePromise(pendingPromise(), at('2026-03-20T00:00:00.000Z'), -1),
      'PROMISE_GRACE_INVALID',
    );
  });

  it('refuses expiry on other paths (table)', () => {
    const table: Array<[PromiseStatus, string]> = [
      ['partially_fulfilled', 'PROMISE_TRANSITION_INVALID'],
      ['fulfilled', 'PROMISE_TRANSITION_INVALID'],
      ['broken', 'PROMISE_TRANSITION_INVALID'],
      ['cancelled', 'PROMISE_TRANSITION_INVALID'],
      ['expired', 'PROMISE_TRANSITION_INVALID'],
    ];
    for (const [status, code] of table) {
      expectCode(
        () => expirePromise(promiseIn(status), at('2026-03-20T00:00:00.000Z')),
        code,
      );
    }
  });

  it('refuses to expire a promise that has coverage — it breaks instead', () => {
    // Defensive guard (same data-in/data-out rationale as markPromiseBroken).
    const corrupted = { ...pendingPromise(), settledMinor: 20_000 };
    expectCode(
      () => expirePromise(corrupted, at('2026-03-20T00:00:00.000Z')),
      'PROMISE_ALREADY_FULFILLED',
    );
  });
});

// --- end-to-end lifecycles -------------------------------------------------------------

describe('the promise lifecycle end to end', () => {
  it('kept promise: created → pending → partially_fulfilled → fulfilled', () => {
    const created = createPromise(
      baseArgs({ source: 'call', consentRef: 'consent-9' }),
      at(T0),
    ).promise;
    const pending = transitionPromise(
      created,
      'pending',
      { reason: 'r', actorId: 'a' },
      at(T0),
    ).promise;
    const partial = applySettlement(pending, 30_000, at('2026-03-04T10:00:00.000Z')).promise;
    const fulfilled = applySettlement(partial, 20_000, at('2026-03-09T10:00:00.000Z')).promise;
    expect([created.status, pending.status, partial.status, fulfilled.status]).toEqual([
      'created',
      'pending',
      'partially_fulfilled',
      'fulfilled',
    ]);
    expect(fulfilled.settledMinor).toBe(50_000);
  });

  it('broken promise: created → pending → broken (collections trigger), terminal', () => {
    const pending = pendingPromise();
    const { promise, events } = markPromiseBroken(
      pending,
      { reason: 'missed' },
      at('2026-03-13T10:00:00.000Z'),
    );
    expect(promise.status).toBe('broken');
    expect(events.map((e) => e.name)).toEqual(['promise.broken', 'collections.promiseBroken']);
    expectCode(
      () => transitionPromise(promise, 'pending', { reason: 'reopen', actorId: 'a' }, at(T0)),
      'PROMISE_TRANSITION_INVALID',
    );
    expectCode(() => applySettlement(promise, 1_000, at(T0)), 'PROMISE_TRANSITION_INVALID');
  });

  it('every operation returns a fresh copy — the input aggregate is never mutated', () => {
    const before = pendingPromise();
    const snapshot = JSON.stringify(before);
    applySettlement(before, 10_000, at('2026-03-05T10:00:00.000Z'));
    markPromiseBroken(before, { reason: 'r' }, at('2026-03-13T10:00:00.000Z'));
    transitionPromise(before, 'cancelled', { reason: 'r', actorId: 'a' }, at(T0));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

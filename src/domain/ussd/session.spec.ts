import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { balanceQueryFlow } from './flows';
import type { UssdFlowHandlers } from './flows';
import { assertMenuGraph } from './menu';
import type { UssdMenuNode, UssdScreen } from './menu';
import {
  DEFAULT_USSD_TTL_MS,
  SESSION_ABORTED_TEXT_KEY,
  SESSION_EXPIRED_TEXT_KEY,
  USSD_INPUT_MAX_CHARS,
  endUssdSession,
  expireUssdSession,
  nodeTrail,
  normalizeMsisdn,
  respond,
  startUssdSession,
  type StartUssdSessionArgs,
  type UssdSession,
} from './session';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(701);
const CUSTOMER = uid(702);
const SESSION_ID = uid(703);

const T0 = '2026-06-01T09:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const plus = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();
const MSISDN = '+254712345678';

const demoGraph = (): UssdMenuNode[] => [
  {
    nodeKey: 'root',
    textKey: 'ussd.menu.root',
    isRoot: true,
    options: [
      { key: '1', textKey: 'ussd.menu.balance', target: { kind: 'flow', flow: 'balance_query' } },
      { key: '2', textKey: 'ussd.menu.invoices', target: { kind: 'node', nodeKey: 'invoices' } },
      { key: '3', textKey: 'ussd.menu.pay', target: { kind: 'node', nodeKey: 'pay' } },
      { key: '9', textKey: 'ussd.menu.exit', target: { kind: 'node', nodeKey: 'goodbye' } },
    ],
  },
  {
    nodeKey: 'invoices',
    textKey: 'ussd.menu.invoices',
    options: [
      { key: '1', textKey: 'ussd.menu.invoice_list', target: { kind: 'flow', flow: 'invoice_list' } },
      { key: '2', textKey: 'ussd.menu.pay_one', target: { kind: 'node', nodeKey: 'pay' } },
    ],
  },
  {
    nodeKey: 'pay',
    textKey: 'ussd.menu.pay',
    options: [
      {
        key: '1',
        textKey: 'ussd.menu.pay_handoff',
        target: { kind: 'flow', flow: 'payment_handoff', args: { invoiceId: 'opaque-1' } },
      },
    ],
  },
  { nodeKey: 'goodbye', textKey: 'ussd.menu.goodbye', terminal: true },
];

const GRAPH = assertMenuGraph(demoGraph());

const BALANCE_HANDLERS: UssdFlowHandlers = {
  balance_query: balanceQueryFlow(() => ({
    available: true,
    data: { amountMinor: 125050, currency: 'KES' },
    evidenceRef: 'evid-balance-1',
  })),
};

const start = (overrides: Partial<StartUssdSessionArgs> = {}, iso: string = T0): UssdSession =>
  startUssdSession(
    {
      sessionId: SESSION_ID,
      orgId: ORG,
      customerId: CUSTOMER,
      msisdn: MSISDN,
      rootKey: 'root',
      ...overrides,
    },
    at(iso),
  ).session;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- starting ------------------------------------------------------------------

describe('startUssdSession — dial-in at the menu root', () => {
  it('starts a session in `started` state at the root with the default 180s horizon', () => {
    const { session } = startUssdSession(
      { sessionId: SESSION_ID, orgId: ORG, customerId: CUSTOMER, msisdn: '0712345678', rootKey: 'root' },
      at(T0),
    );
    expect(session.state).toBe('started');
    expect(session.currentNodeKey).toBe('root');
    expect(session.msisdn).toBe('+254712345678');
    expect(session.ttlMs).toBe(DEFAULT_USSD_TTL_MS);
    expect(session.ttlMs).toBe(180_000);
    expect(session.inputHistory).toEqual([]);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(180_000);
  });

  it('emits ussd.sessionStarted with a narrow envelope — and never the MSISDN', () => {
    const { event } = startUssdSession(
      { sessionId: SESSION_ID, orgId: ORG, customerId: CUSTOMER, msisdn: MSISDN, rootKey: 'root' },
      at(T0),
    );
    expect(event.name).toBe('ussd.sessionStarted');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(SESSION_ID);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toEqual({
      sessionId: SESSION_ID,
      orgId: ORG,
      customerId: CUSTOMER,
      rootKey: 'root',
      startedAt: T0,
    });
    expect(JSON.stringify(event)).not.toContain('712345678');
    expect(JSON.stringify(event)).not.toContain('0712');
  });

  it('ttl validation table — safe positive integers only; custom ttl respected', () => {
    expect(start({ ttlMs: 60_000 }).expiresAt.toISOString()).toBe(plus(T0, 60_000));
    expectCode(() => start({ ttlMs: 0 }), 'USSD_TTL_INVALID');
    expectCode(() => start({ ttlMs: -1 }), 'USSD_TTL_INVALID');
    expectCode(() => start({ ttlMs: 1.5 }), 'USSD_TTL_INVALID');
    expectCode(() => start({ ttlMs: Number.NaN }), 'USSD_TTL_INVALID');
    expectCode(() => start({ ttlMs: Number.POSITIVE_INFINITY }), 'USSD_TTL_INVALID');
  });

  it('required-args table + broken clock', () => {
    expectCode(() => start({ sessionId: ' ' as Uuid }), 'USSD_SESSION_ID_REQUIRED');
    expectCode(() => start({ orgId: '' as Uuid }), 'USSD_ORG_REQUIRED');
    expectCode(() => start({ customerId: undefined as unknown as Uuid }), 'USSD_CUSTOMER_REQUIRED');
    expectCode(() => start({ rootKey: '' }), 'USSD_ROOT_KEY_REQUIRED');
    expectCode(
      () =>
        startUssdSession(
          { sessionId: SESSION_ID, orgId: ORG, customerId: CUSTOMER, msisdn: MSISDN, rootKey: 'root' },
          { now: () => new Date('nope') },
        ),
      'USSD_CLOCK_INVALID',
    );
  });
});

// --- MSISDN normalization table -------------------------------------------------

describe('normalizeMsisdn — Kenya +254 table', () => {
  const valid: readonly [string, string][] = [
    ['+254712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['00254712345678', '+254712345678'],
    ['0712345678', '+254712345678'],
    ['712345678', '+254712345678'],
    ['+254 712 345 678', '+254712345678'],
    ['0712-345-678', '+254712345678'],
    ['+254712-345.678', '+254712345678'],
    ['0712345678 ', '+254712345678'],
    ['0112345678', '+254112345678'], // the newer 01xx mobile range
    ['+254112345678', '+254112345678'],
  ];
  it.each(valid)('normalizes %s → %s', (raw, expected) => {
    expect(normalizeMsisdn(raw)).toBe(expected);
  });

  const invalid: readonly string[] = [
    '', 'abc', '12345', '0812345678', // 8-prefix is not a mobile range
    '71234567', '7123456789', // wrong lengths
    '+254212345678', // landline shape
    '+15401234567', // not Kenya
    '+25471234567 8 9', // too many digits after stripping
    '254-7123456789',
  ];
  it.each(invalid.map((raw) => [raw]))('refuses %s with USSD_MSISDN_INVALID (no digits echoed)', (raw) => {
    try {
      normalizeMsisdn(raw);
      throw new Error(`expected refusal for '${String(raw)}'`);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe('USSD_MSISDN_INVALID');
      expect(domainError.message).not.toMatch(/\d{4}/); // no subscriber digits in the message
      expect(JSON.stringify(domainError.details)).not.toMatch(/\d{4}/);
    }
  });

  it('non-string input is refused without echoing it', () => {
    expectCode(() => normalizeMsisdn(undefined as unknown as string), 'USSD_MSISDN_INVALID');
  });
});

// --- navigation -------------------------------------------------------------------

describe('respond — navigation steps', () => {
  it('the first processed input activates the session and moves it', () => {
    const step = respond(start(), '2', at(T0), GRAPH);
    expect(step.kind).toBe('navigation');
    expect(step.session.state).toBe('active');
    expect(step.session.currentNodeKey).toBe('invoices');
    expect(step.screen).toEqual({ textKey: 'ussd.menu.invoices' });
  });

  it('a navigation step emits ussd.navigated and appends the keypress to the history', () => {
    const step = respond(start(), '2', at(T0), GRAPH);
    if (step.kind !== 'navigation') throw new Error(`expected navigation, got ${step.kind}`);
    expect(step.event.name).toBe('ussd.navigated');
    expect(step.event.aggregateId).toBe(SESSION_ID);
    expect(step.event.payload).toMatchObject({
      sessionId: SESSION_ID,
      orgId: ORG,
      customerId: CUSTOMER,
      fromNode: 'root',
      toNode: 'invoices',
      via: '2',
      navigatedAt: T0,
    });
    expect(step.session.inputHistory).toEqual(['2']);
    // the idle horizon refreshed on activity
    expect(step.session.lastActiveAt.toISOString()).toBe(T0);
    expect(step.session.expiresAt.toISOString()).toBe(plus(T0, 180_000));
  });

  it('landing on a terminal node ends the session: menu_exit with two events', () => {
    const step = respond(start(), '9', at(T0), GRAPH);
    expect(step.kind).toBe('end');
    if (step.kind !== 'end') return;
    expect(step.reason).toBe('menu_exit');
    expect(step.session.state).toBe('ended');
    expect(step.screen).toEqual({ textKey: 'ussd.menu.goodbye' });
    expect(step.events.map((e) => e.name)).toEqual(['ussd.navigated', 'ussd.sessionEnded']);
  });

  it('determinism: identical inputs produce bit-for-bit identical steps', () => {
    const a = respond(start(), '2', at(T0), GRAPH);
    const b = respond(start(), '2', at(T0), GRAPH);
    expect(a).toEqual(b);
  });

  it('no-mutation: the input session object is never touched', () => {
    const original = start();
    const snapshot = JSON.stringify(original);
    respond(original, '2', at(T0), GRAPH);
    respond(original, '#', at(T0), GRAPH);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(original.inputHistory).toEqual([]);
  });
});

// --- re-prompt (the customer-event path) -----------------------------------------

describe('respond — invalid input re-prompts as a VALUE', () => {
  it('an unknown key returns a reprompt step, same node, USSD_INPUT_INVALID', () => {
    const step = respond(start(), '7', at(T0), GRAPH);
    expect(step.kind).toBe('reprompt');
    if (step.kind !== 'reprompt') return;
    expect(step.reason).toBe('USSD_INPUT_INVALID');
    expect(step.session.state).toBe('active'); // still activated by the attempt
    expect(step.session.currentNodeKey).toBe('root');
    expect(step.screen).toEqual({ textKey: 'ussd.menu.root' }); // the same screen again
    expect(step.event.name).toBe('ussd.inputRejected');
    expect(step.event.payload).toMatchObject({ nodeKey: 'root', input: '7', rejectedAt: T0 });
  });

  it('re-prompt idempotence: repeated wrong keys return the same screen every time', () => {
    let session = start();
    const screens: UssdScreen[] = [];
    for (const key of ['7', 'x', '42', '']) {
      const step = respond(session, key, at(T0), GRAPH);
      if (step.kind !== 'reprompt') throw new Error(`expected reprompt for '${key}'`);
      screens.push(step.screen);
      session = step.session;
    }
    expect(screens.every((s) => s.textKey === 'ussd.menu.root')).toBe(true);
    expect(session.inputHistory).toEqual(['7', 'x', '42', '']);
  });

  it('inputs longer than the cap are truncated before anything else sees them', () => {
    const step = respond(start(), '123456789ABC', at(T0), GRAPH);
    if (step.kind !== 'reprompt') throw new Error('expected reprompt');
    expect(USSD_INPUT_MAX_CHARS).toBe(8);
    expect(step.event.payload.input).toBe('12345678');
    expect(step.session.inputHistory).toEqual(['12345678']);
  });

  it('a non-string input is an adapter bug and throws', () => {
    expectCode(() => respond(start(), undefined as unknown as string, at(T0), GRAPH), 'USSD_INPUT_INVALID');
  });

  it('back at the root has nowhere to go → re-prompt', () => {
    const step = respond(start(), '0', at(T0), GRAPH);
    expect(step.kind).toBe('reprompt');
  });
});

// --- back-navigation (trail replay) ------------------------------------------------

describe('respond — back-navigation replays the actual trail', () => {
  it('backs up one level along the visited path, via the back key', () => {
    let session = start();
    session = respond(session, '2', at(T0), GRAPH).session; // root → invoices
    session = respond(session, '2', at(T0), GRAPH).session; // invoices → pay
    const step = respond(session, '0', at(T0), GRAPH);
    expect(step.kind).toBe('navigation');
    if (step.kind !== 'navigation') return;
    expect(step.session.currentNodeKey).toBe('invoices');
    expect(step.event.payload.via).toBe('0');
    expect(step.event.payload.fromNode).toBe('pay');
  });

  it('backs all the way to the root, then refuses to back past it', () => {
    let session = start();
    session = respond(session, '2', at(T0), GRAPH).session;
    session = respond(session, '2', at(T0), GRAPH).session;
    session = respond(session, '0', at(T0), GRAPH).session; // pay → invoices
    const step = respond(session, '0', at(T0), GRAPH); // invoices → root
    if (step.kind !== 'navigation') throw new Error('expected navigation');
    expect(step.session.currentNodeKey).toBe('root');
    // at the root again: back is now a re-prompt
    const atRoot = respond(step.session, '0', at(T0), GRAPH);
    expect(atRoot.kind).toBe('reprompt');
  });

  it('replay ignores rejected keys and flow keys — multi-parent back follows the real trail', () => {
    // root →2→ invoices; ('7' rejected); →2→ pay (pay has TWO parents: root and invoices)
    let session = start();
    session = respond(session, '2', at(T0), GRAPH).session;
    session = respond(session, '7', at(T0), GRAPH).session; // rejected at invoices
    session = respond(session, '2', at(T0), GRAPH).session; // invoices → pay
    const step = respond(session, '0', at(T0), GRAPH);
    if (step.kind !== 'navigation') throw new Error('expected navigation');
    expect(step.session.currentNodeKey).toBe('invoices'); // NOT root — the most recent path
  });

  it('nodeTrail is exposed and mirrors the walk', () => {
    expect(nodeTrail(GRAPH, [])).toEqual(['root']);
    expect(nodeTrail(GRAPH, ['2', '7', '2'])).toEqual(['root', 'invoices', 'pay']);
    expect(nodeTrail(GRAPH, ['9'])).toEqual(['root', 'goodbye']);
  });
});

// --- abort ------------------------------------------------------------------------

describe('respond — # aborts from anywhere', () => {
  it('aborts a live session with ussd.sessionAborted', () => {
    const step = respond(start(), '#', at(T0), GRAPH);
    expect(step.kind).toBe('end');
    if (step.kind !== 'end') return;
    expect(step.reason).toBe('aborted_by_customer');
    expect(step.session.state).toBe('aborted');
    expect(step.screen).toEqual({ textKey: SESSION_ABORTED_TEXT_KEY });
    expect(step.session.inputHistory).toEqual(['#']);
    expect(step.events).toHaveLength(1);
    expect(step.events[0]!.name).toBe('ussd.sessionAborted');
    expect(step.events[0]!.payload).toMatchObject({ nodeKey: 'root', abortedAt: T0 });
  });

  it('aborts mid-menu too', () => {
    let session = start();
    session = respond(session, '3', at(T0), GRAPH).session;
    const step = respond(session, '#', at(T0), GRAPH);
    expect(step.kind).toBe('end');
    if (step.kind !== 'end') return;
    expect(step.events[0]!.payload).toMatchObject({ nodeKey: 'pay' });
  });

  it('a dead session accepts no input', () => {
    const aborted = respond(start(), '#', at(T0), GRAPH).session;
    expectCode(() => respond(aborted, '1', at(T0), GRAPH), 'USSD_SESSION_NOT_ACTIVE');
  });
});

// --- expiry (±1ms) -------------------------------------------------------------------

describe('respond + sweeper — idle expiry at the horizon', () => {
  it('processes normally 1ms before the horizon, refuses AT the horizon', () => {
    const session = start();
    const justBefore = respond(session, '2', at(plus(T0, DEFAULT_USSD_TTL_MS - 1)), GRAPH);
    expect(justBefore.kind).toBe('navigation');
    expect(justBefore.session.state).toBe('active');

    const atHorizon = respond(session, '2', at(plus(T0, DEFAULT_USSD_TTL_MS)), GRAPH);
    expect(atHorizon.kind).toBe('expired');
    if (atHorizon.kind !== 'expired') return;
    expect(atHorizon.session.state).toBe('expired');
    expect(atHorizon.screen).toEqual({ textKey: SESSION_EXPIRED_TEXT_KEY });
    expect(atHorizon.event.name).toBe('ussd.sessionExpired');
    expect(atHorizon.event.payload).toMatchObject({ idleTtlMs: 180_000, expiredAt: plus(T0, DEFAULT_USSD_TTL_MS) });
    // the late input was never processed — history untouched
    expect(atHorizon.session.inputHistory).toEqual([]);
  });

  it('an expired session accepts no input afterwards', () => {
    const session = start();
    const expired = respond(session, '2', at(plus(T0, DEFAULT_USSD_TTL_MS)), GRAPH).session;
    expectCode(() => respond(expired, '1', at(T0), GRAPH), 'USSD_SESSION_NOT_ACTIVE');
  });

  it('the sweeper: USSD_SESSION_NOT_DUE before the horizon, expired from the horizon on', () => {
    const session = start();
    expectCode(() => expireUssdSession(session, at(plus(T0, DEFAULT_USSD_TTL_MS - 1))), 'USSD_SESSION_NOT_DUE');
    const swept = expireUssdSession(session, at(plus(T0, DEFAULT_USSD_TTL_MS)));
    expect(swept.session.state).toBe('expired');
    expect(swept.event.name).toBe('ussd.sessionExpired');
    expect(swept.event.occurredAt).toBe(plus(T0, DEFAULT_USSD_TTL_MS));
    const later = expireUssdSession(session, at(plus(T0, DEFAULT_USSD_TTL_MS + 5_000)));
    expect(later.event.occurredAt).toBe(plus(T0, DEFAULT_USSD_TTL_MS + 5_000));
  });

  it('the sweeper never resurrects or double-sweeps a terminal session', () => {
    const ended = endUssdSession(start(), { reason: 'network_release' }, at(T0)).session;
    expectCode(() => expireUssdSession(ended, at(plus(T0, DEFAULT_USSD_TTL_MS))), 'USSD_SESSION_NOT_ACTIVE');
    const swept = expireUssdSession(start(), at(plus(T0, DEFAULT_USSD_TTL_MS))).session;
    expectCode(() => expireUssdSession(swept, at(plus(T0, DEFAULT_USSD_TTL_MS * 2))), 'USSD_SESSION_NOT_ACTIVE');
  });
});

// --- explicit end ------------------------------------------------------------------

describe('endUssdSession — the adapter says goodbye', () => {
  it('ends a live session with the caller reason', () => {
    const { session, event } = endUssdSession(start(), { reason: 'network_release' }, at(T0));
    expect(session.state).toBe('ended');
    expect(event.name).toBe('ussd.sessionEnded');
    expect(event.payload).toMatchObject({ sessionId: SESSION_ID, reason: 'network_release', endedAt: T0 });
  });

  it('requires a non-blank reason and refuses terminal sessions', () => {
    expectCode(() => endUssdSession(start(), { reason: ' ' }, at(T0)), 'USSD_REASON_REQUIRED');
    const ended = endUssdSession(start(), { reason: 'x' }, at(T0)).session;
    expectCode(() => endUssdSession(ended, { reason: 'again' }, at(T0)), 'USSD_SESSION_NOT_ACTIVE');
  });
});

// --- flow dispatch through respond --------------------------------------------------

describe('respond — flow dispatch, budget demotion, PII pin', () => {
  it('a wired flow completes: outcome value + flowCompleted + sessionEnded, screen within budget', () => {
    const step = respond(start(), '1', at(T0), GRAPH, BALANCE_HANDLERS);
    expect(step.kind).toBe('flow');
    if (step.kind !== 'flow') return;
    expect(step.outcome.status).toBe('completed');
    if (step.outcome.status !== 'completed') return;
    expect(step.outcome.result).toMatchObject({
      flow: 'balance_query',
      amountMinor: 125050,
      currency: 'KES',
      display: '1250.50 KES',
      evidenceRef: 'evid-balance-1',
    });
    expect(step.screen).toEqual({
      textKey: 'ussd.flow.balance_query.completed',
      params: { amount: '1250.50 KES' },
    });
    expect(step.session.state).toBe('ended');
    expect(step.session.inputHistory).toEqual(['1']);
    expect(step.events.map((e) => e.name)).toEqual(['ussd.flowCompleted', 'ussd.sessionEnded']);
    expect(step.events[0]!.payload).toMatchObject({ flow: 'balance_query', evidenceRef: 'evid-balance-1' });
    expect(step.events[1]!.payload).toMatchObject({ reason: 'flow_completed' });
  });

  it('an unwired flow is a USSD_FLOW_NOT_WIRED failure VALUE + flowFailed + sessionEnded', () => {
    const step = respond(start(), '1', at(T0), GRAPH); // no handlers at all
    expect(step.kind).toBe('flow');
    if (step.kind !== 'flow') return;
    expect(step.outcome).toEqual({
      status: 'failed',
      code: 'USSD_FLOW_NOT_WIRED',
      detail: "no handler wired for flow 'balance_query'",
    });
    expect(step.screen).toEqual({ textKey: 'ussd.flow.failed', params: { code: 'USSD_FLOW_NOT_WIRED' } });
    expect(step.events.map((e) => e.name)).toEqual(['ussd.flowFailed', 'ussd.sessionEnded']);
    expect(step.events[0]!.payload).toMatchObject({ flow: 'balance_query', reason: 'USSD_FLOW_NOT_WIRED' });
    expect(step.events[1]!.payload).toMatchObject({ reason: 'flow_failed' });
  });

  it('an over-budget answer is DEMOTED to USSD_SCREEN_OVERBUDGET instead of shown', () => {
    const hugeListHandlers: UssdFlowHandlers = {
      invoice_list: () => ({
        status: 'completed',
        result: {
          flow: 'invoice_list',
          totalAvailable: 2,
          shown: 2,
          lines: ['INV-1 100.00 KES due 2026-05-01', 'I'.repeat(300)],
          evidenceRef: 'evid-list-1',
        },
      }),
    };
    // navigate: root '2' → invoices; invoices '1' → invoice_list flow
    let session = start();
    session = respond(session, '2', at(T0), GRAPH).session;
    const flowStep = respond(session, '1', at(T0), GRAPH, hugeListHandlers);
    expect(flowStep.kind).toBe('flow');
    if (flowStep.kind !== 'flow') return;
    expect(flowStep.outcome.status).toBe('failed');
    if (flowStep.outcome.status !== 'failed') return;
    expect(flowStep.outcome.code).toBe('USSD_SCREEN_OVERBUDGET');
    expect(flowStep.screen).toEqual({ textKey: 'ussd.flow.failed', params: { code: 'USSD_SCREEN_OVERBUDGET' } });
    expect(flowStep.events[0]!.name).toBe('ussd.flowFailed');
    expect(flowStep.events[0]!.payload).toMatchObject({ reason: 'USSD_SCREEN_OVERBUDGET' });
  });

  it('a corrupted session pointing outside the graph is an adapter bug → USSD_MENU_NODE_UNKNOWN', () => {
    const corrupted: UssdSession = { ...start(), currentNodeKey: 'removed-node' };
    expectCode(() => respond(corrupted, '1', at(T0), GRAPH), 'USSD_MENU_NODE_UNKNOWN');
  });

  it('PII pin: a full walk across the machine never leaks the MSISDN into events', () => {
    const handlers: UssdFlowHandlers = {
      balance_query: BALANCE_HANDLERS.balance_query!,
      payment_handoff: () => ({
        status: 'completed',
        result: { flow: 'payment_handoff', handoffRef: 'ho-1', invoiceId: null, payRef: 'm-pesa', evidenceRef: 'evid-ho-1' },
      }),
    };
    const collected: unknown[] = [];
    let session = start();
    collected.push(startUssdSession(
      { sessionId: SESSION_ID, orgId: ORG, customerId: CUSTOMER, msisdn: MSISDN, rootKey: 'root' },
      at(T0),
    ).event);
    const steps = [
      respond(session, '1', at(T0), GRAPH, handlers), // balance flow → ends session
    ];
    for (const step of steps) collected.push(...('event' in step ? [step.event] : []), ...('events' in step ? step.events : []));
    // second session walks navigation + abort
    let s2 = start();
    const nav = respond(s2, '3', at(T0), GRAPH);
    collected.push(nav.kind === 'navigation' ? nav.event : undefined);
    s2 = nav.session;
    const abort = respond(s2, '#', at(T0), GRAPH);
    collected.push(...('events' in abort ? abort.events : []));
    const serialized = JSON.stringify(collected.filter(Boolean));
    expect(serialized).not.toContain('712345678');
    expect(serialized).not.toContain('+254');
  });
});

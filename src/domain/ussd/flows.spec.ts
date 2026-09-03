import { describe, expect, it } from 'vitest';
import { DomainError, type Currency, type Uuid, uuid } from '../shared';
import {
  DEFAULT_FLOW_TEXT_KEYS,
  DEFAULT_INVOICE_LIMIT,
  FLOW_FAILED_TEXT_KEY,
  balanceQueryFlow,
  flowScreen,
  invoiceListFlow,
  paymentHandoffFlow,
  planRequestFlow,
  statementQueryFlow,
  type BalanceData,
  type InvoiceSummary,
  type UssdFlowContext,
  type UssdFlowOutcome,
  type UssdFlowResult,
  type UssdPortAnswer,
} from './flows';
import { screenCost } from './menu';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(801);
const CUSTOMER = uid(802);

const T0 = '2026-06-01T09:00:00.000Z';
const CTX: UssdFlowContext = {
  orgId: ORG,
  customerId: CUSTOMER,
  msisdn: '+254712345678',
  now: new Date(T0),
  args: Object.freeze({}) as Readonly<Record<string, string>>,
};

const invoice = (n: number, overrides: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  invoiceId: uid(900 + n),
  number: `INV-2026-000${n}`,
  dueAmountMinor: 100_00 * n,
  currency: 'KES',
  dueDate: `2026-05-0${n}T00:00:00.000Z`,
  ...overrides,
});

const available = <T>(data: T, evidenceRef = 'evid-1') => ({ available: true as const, data, evidenceRef });
const unavailable = (reason = 'ledger snapshot not ready') => ({ available: false as const, reason });

/** Build a completed flow outcome (the VALUES-only contract of the flow handlers). */
const completed = (result: UssdFlowResult): UssdFlowOutcome => ({ status: 'completed', result });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const expectFlowFailed = (outcome: UssdFlowOutcome, code: string, detailPart?: string): void => {
  expect(outcome.status).toBe('failed');
  if (outcome.status !== 'failed') return;
  expect(outcome.code).toBe(code);
  if (detailPart !== undefined) expect(outcome.detail).toContain(detailPart);
};

// --- balance_query -------------------------------------------------------------

describe('balanceQueryFlow — F29 "Check balance"', () => {
  it('carries the amount, currency, deterministic display and the evidence ref', () => {
    const outcome = balanceQueryFlow(() => available({ amountMinor: 125050, currency: 'KES' }, 'evid-bal-1'))(CTX);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result).toEqual({
      flow: 'balance_query',
      amountMinor: 125050,
      currency: 'KES',
      display: '1250.50 KES',
      evidenceRef: 'evid-bal-1',
    });
  });

  it('zero balances are legal (boundary); non-integer / negative / NaN are refused', () => {
    expect(balanceQueryFlow(() => available({ amountMinor: 0, currency: 'KES' }))(CTX).status).toBe('completed');
    expectFlowFailed(balanceQueryFlow(() => available({ amountMinor: -1, currency: 'KES' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(balanceQueryFlow(() => available({ amountMinor: 1.5, currency: 'KES' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(balanceQueryFlow(() => available({ amountMinor: Number.NaN, currency: 'KES' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(balanceQueryFlow(() => available({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'KES' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
  });

  it('unknown currencies are refused — deny-by-default', () => {
    expectFlowFailed(
      balanceQueryFlow(() => available({ amountMinor: 100, currency: 'GBPX' as 'KES' }))(CTX),
      'USSD_FLOW_PORT_MALFORMED',
    );
    expectFlowFailed(
      balanceQueryFlow(() => available({ amountMinor: 100, currency: undefined as unknown as 'KES' }))(CTX),
      'USSD_FLOW_PORT_MALFORMED',
    );
  });

  it('unavailability, thrown ports and evidence-less answers are failure VALUES', () => {
    expectFlowFailed(
      balanceQueryFlow(() => unavailable('ledger snapshot not ready'))(CTX),
      'USSD_FLOW_UNAVAILABLE',
      'ledger snapshot not ready',
    );
    expectFlowFailed(
      balanceQueryFlow(() => {
        throw new DomainError('LEDGER_DOWN', 'read replica unreachable');
      })(CTX),
      'USSD_FLOW_UNAVAILABLE',
      'LEDGER_DOWN',
    );
    expectFlowFailed(
      balanceQueryFlow(() => {
        throw new TypeError('cannot read properties of undefined');
      })(CTX),
      'USSD_FLOW_UNAVAILABLE',
      'TypeError',
    );
    expectFlowFailed(
      balanceQueryFlow(() => available({ amountMinor: 100, currency: 'KES' as Currency }, '   '))(CTX),
      'USSD_FLOW_EVIDENCE_REQUIRED',
    );
    expectFlowFailed(
      balanceQueryFlow(() => null as unknown as UssdPortAnswer<BalanceData>)(CTX),
      'USSD_FLOW_PORT_MALFORMED',
    );
  });

  it('deterministic: the same answer renders the same outcome bit-for-bit', () => {
    const port = () => available({ amountMinor: 125050, currency: 'KES' as Currency });
    expect(balanceQueryFlow(port)(CTX)).toEqual(balanceQueryFlow(port)(CTX));
  });
});

// --- invoice_list -----------------------------------------------------------------

describe('invoiceListFlow — F29 "View invoice"', () => {
  it('formats due lines and counts the total beyond the shown window', () => {
    const outcome = invoiceListFlow(() =>
      available({ invoices: [invoice(1), invoice(2), invoice(3), invoice(4), invoice(5)] }, 'evid-inv-1'),
    )(CTX);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result.flow).toBe('invoice_list');
    if (outcome.result.flow !== 'invoice_list') return;
    expect(outcome.result.shown).toBe(DEFAULT_INVOICE_LIMIT);
    expect(outcome.result.shown).toBe(3);
    expect(outcome.result.totalAvailable).toBe(5);
    expect(outcome.result.lines).toEqual([
      'INV-2026-0001 100.00 KES due 2026-05-01',
      'INV-2026-0002 200.00 KES due 2026-05-02',
      'INV-2026-0003 300.00 KES due 2026-05-03',
    ]);
    expect(outcome.result.evidenceRef).toBe('evid-inv-1');
  });

  it('a custom limit widens the window; a zero limit is a wiring bug (throws)', () => {
    const port = () => available({ invoices: [invoice(1), invoice(2)] });
    const wide = invoiceListFlow(port, { limit: 10 })(CTX);
    expect(wide.status).toBe('completed');
    if (wide.status === 'completed' && wide.result.flow === 'invoice_list') {
      expect(wide.result.shown).toBe(2);
    }
    expectCode(() => invoiceListFlow(port, { limit: 0 }), 'USSD_FLOW_LIMIT_INVALID');
    expectCode(() => invoiceListFlow(port, { limit: 1.5 }), 'USSD_FLOW_LIMIT_INVALID');
  });

  it('malformed rows are refused — even rows beyond the display limit', () => {
    const rows: InvoiceSummary[] = [invoice(1), invoice(2), invoice(3), invoice(4)];
    const broken = (patch: (row: InvoiceSummary) => Partial<InvoiceSummary>): InvoiceSummary[] =>
      rows.map((row, i) => (i === 3 ? { ...row, ...patch(row) } : row));
    const cases: ((row: InvoiceSummary) => Partial<InvoiceSummary>)[] = [
      () => ({ invoiceId: ' ' as Uuid }),
      () => ({ number: '' }),
      () => ({ dueAmountMinor: -5 }),
      () => ({ currency: 'USD' as 'KES' }), // valid currency but wrong-by-construction? no — valid; use junk below
      () => ({ dueDate: '05/01/2026' }),
      () => ({ dueDate: 'not-a-date' }),
    ];
    // NOTE: 'USD' is a KNOWN currency — swap that row for genuine junk:
    cases[3] = () => ({ currency: 'KSH' as 'KES' });
    for (const patch of cases) {
      const outcome = invoiceListFlow(() => available({ invoices: broken(patch) }), { limit: 3 })(CTX);
      expectFlowFailed(outcome, 'USSD_FLOW_PORT_MALFORMED');
    }
    expectFlowFailed(invoiceListFlow(() => available({ invoices: 'three' as unknown as InvoiceSummary[] }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(invoiceListFlow(() => available({ invoices: [null as unknown as InvoiceSummary] }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
  });

  it('unavailability and thrown ports surface as USSD_FLOW_UNAVAILABLE', () => {
    expectFlowFailed(invoiceListFlow(() => unavailable('no invoices service'))(CTX), 'USSD_FLOW_UNAVAILABLE', 'no invoices service');
    expectFlowFailed(
      invoiceListFlow(() => {
        throw new Error('boom');
      })(CTX),
      'USSD_FLOW_UNAVAILABLE',
      'boom',
    );
  });
});

// --- statement_query -----------------------------------------------------------------

describe('statementQueryFlow — F29 "Get statement"', () => {
  it('passes the requested period through and carries the summary + evidence', () => {
    const seen: string[] = [];
    const outcome = statementQueryFlow((request) => {
      seen.push(request.period);
      return available(
        {
          statementRef: 'stmt-2026-05',
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
          totalInvoicedMinor: 500_00,
          totalPaidMinor: 350_00,
          currency: 'KES',
        },
        'evid-stmt-1',
      );
    })({ ...CTX, args: { period: 'last_30_days' } });
    expect(seen).toEqual(['last_30_days']);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result).toEqual({
      flow: 'statement_query',
      statementRef: 'stmt-2026-05',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      totalInvoicedMinor: 500_00,
      totalPaidMinor: 350_00,
      currency: 'KES',
      evidenceRef: 'evid-stmt-1',
    });
  });

  it('an absent period arrives as an empty string (the port decides the default)', () => {
    const seen: string[] = [];
    statementQueryFlow((request) => {
      seen.push(request.period);
      return unavailable('no statement');
    })(CTX);
    expect(seen).toEqual(['']);
  });

  it('malformed statements are refused', () => {
    const good = {
      statementRef: 'stmt-1',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      totalInvoicedMinor: 500_00,
      totalPaidMinor: 350_00,
      currency: 'KES' as const,
    };
    expectFlowFailed(statementQueryFlow(() => available({ ...good, statementRef: '' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(statementQueryFlow(() => available({ ...good, periodEnd: '31/05/2026' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(statementQueryFlow(() => available({ ...good, totalPaidMinor: -1 }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(statementQueryFlow(() => available({ ...good, totalInvoicedMinor: 10.5 }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(statementQueryFlow(() => available({ ...good, currency: 'XXX' as 'KES' }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(statementQueryFlow(() => unavailable('period too long'))(CTX), 'USSD_FLOW_UNAVAILABLE');
  });
});

// --- plan_request + payment_handoff ------------------------------------------------

describe('planRequestFlow — F29 "Request payment plan" (relays intent, never writes truth)', () => {
  it('carries the intent record + evidence ref; a null receivableId passes through', () => {
    const intentId = uid(950);
    const outcome = planRequestFlow(() => available({ planIntentId: intentId, receivableId: null }, 'evid-plan-1'))(CTX);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result).toEqual({
      flow: 'plan_request',
      planIntentRef: intentId,
      receivableId: null,
      evidenceRef: 'evid-plan-1',
    });
    const scoped = planRequestFlow(() => available({ planIntentId: intentId, receivableId: uid(951) }, 'evid-plan-2'))(CTX);
    expect(scoped.status).toBe('completed');
  });

  it('refuses malformed intents', () => {
    const intentId = uid(950);
    expectFlowFailed(planRequestFlow(() => available({ planIntentId: ' ' as Uuid, receivableId: null }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(planRequestFlow(() => available({ planIntentId: intentId, receivableId: 7 as unknown as Uuid }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(planRequestFlow(() => unavailable('plan service closed'))(CTX), 'USSD_FLOW_UNAVAILABLE');
  });
});

describe('paymentHandoffFlow — F29 "Pay invoice" handoff (intake stays in payments)', () => {
  it('carries the handoff descriptor + evidence ref; absent payBy renders as an empty string', () => {
    const invoiceId = uid(960);
    const outcome = paymentHandoffFlow(() => available({ handoffRef: 'ho-1', invoiceId, payBy: 'm-pesa' }, 'evid-ho-1'))(CTX);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result).toEqual({
      flow: 'payment_handoff',
      handoffRef: 'ho-1',
      invoiceId,
      payRef: 'm-pesa',
      evidenceRef: 'evid-ho-1',
    });
    const bare = paymentHandoffFlow(() => available({ handoffRef: 'ho-2', invoiceId: null, payBy: null }, 'evid-ho-2'))(CTX);
    expect(bare.status).toBe('completed');
    if (bare.status === 'completed' && bare.result.flow === 'payment_handoff') {
      expect(bare.result.payRef).toBe('');
      expect(bare.result.invoiceId).toBeNull();
    }
  });

  it('refuses malformed descriptors', () => {
    expectFlowFailed(paymentHandoffFlow(() => available({ handoffRef: '', invoiceId: null, payBy: null }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(paymentHandoffFlow(() => available({ handoffRef: 'ho', invoiceId: 5 as unknown as Uuid, payBy: null }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(paymentHandoffFlow(() => available({ handoffRef: 'ho', invoiceId: null, payBy: 42 as unknown as string }))(CTX), 'USSD_FLOW_PORT_MALFORMED');
    expectFlowFailed(paymentHandoffFlow(() => unavailable('payments lane unreachable'))(CTX), 'USSD_FLOW_UNAVAILABLE', 'payments lane unreachable');
  });
});

// --- result → screen ----------------------------------------------------------------

describe('flowScreen — deterministic result screens (i18n keys, never copy)', () => {
  it('maps each completed result to its textKey + params', () => {
    const completed = (result: UssdFlowOutcome extends never ? never : Extract<UssdFlowOutcome, { status: 'completed' }>['result']): UssdFlowOutcome => ({
      status: 'completed',
      result,
    });
    expect(flowScreen('balance_query', completed({ flow: 'balance_query', amountMinor: 125050, currency: 'KES', display: '1250.50 KES', evidenceRef: 'e1' }))).toEqual({
      textKey: 'ussd.flow.balance_query.completed',
      params: { amount: '1250.50 KES' },
    });
    expect(
      flowScreen('invoice_list', completed({ flow: 'invoice_list', totalAvailable: 5, shown: 3, lines: ['a', 'b', 'c'], evidenceRef: 'e2' })),
    ).toEqual({
      textKey: 'ussd.flow.invoice_list.completed',
      params: { list: 'a|b|c', shown: 3, total: 5 },
    });
    expect(
      flowScreen('statement_query', completed({ flow: 'statement_query', statementRef: 's1', periodStart: '2026-05-01', periodEnd: '2026-05-31', totalInvoicedMinor: 500_00, totalPaidMinor: 350_00, currency: 'KES', evidenceRef: 'e3' })),
    ).toEqual({
      textKey: 'ussd.flow.statement_query.completed',
      params: { ref: 's1', invoiced: '500.00 KES', paid: '350.00 KES' },
    });
    expect(flowScreen('plan_request', completed({ flow: 'plan_request', planIntentRef: 'pi-1', receivableId: null, evidenceRef: 'e4' }))).toEqual({
      textKey: 'ussd.flow.plan_request.completed',
      params: { intent: 'pi-1' },
    });
    expect(flowScreen('payment_handoff', completed({ flow: 'payment_handoff', handoffRef: 'ho-1', invoiceId: null, payRef: 'm-pesa', evidenceRef: 'e5' }))).toEqual({
      textKey: 'ussd.flow.payment_handoff.completed',
      params: { handoff: 'ho-1', payBy: 'm-pesa' },
    });
    expect(DEFAULT_FLOW_TEXT_KEYS.payment_handoff).toBe('ussd.flow.payment_handoff.completed');
  });

  it('failures render the generic failure screen with the stable code', () => {
    expect(flowScreen('balance_query', { status: 'failed', code: 'USSD_FLOW_UNAVAILABLE', detail: 'down' })).toEqual({
      textKey: FLOW_FAILED_TEXT_KEY,
      params: { code: 'USSD_FLOW_UNAVAILABLE' },
    });
    expect(FLOW_FAILED_TEXT_KEY).toBe('ussd.flow.failed');
  });

  it('a realistic list fits the 182-char budget; a huge one cannot (drives the respond-time demotion)', () => {
    const small = flowScreen(
      'invoice_list',
      completed({ flow: 'invoice_list', totalAvailable: 3, shown: 3, lines: ['INV-1 100.00 KES due 2026-05-01', 'INV-2 200.00 KES due 2026-05-02', 'INV-3 300.00 KES due 2026-05-03'], evidenceRef: 'e' }),
    );
    expect(screenCost(small)).toBeLessThanOrEqual(182);
    const huge = flowScreen(
      'invoice_list',
      completed({ flow: 'invoice_list', totalAvailable: 9, shown: 3, lines: ['I'.repeat(90), 'J'.repeat(90), 'K'.repeat(90)], evidenceRef: 'e' }),
    );
    expect(screenCost(huge)).toBeGreaterThan(182);
  });

  it('deterministic: same outcome → same screen, bit-for-bit', () => {
    const outcome: UssdFlowOutcome = completed({ flow: 'plan_request', planIntentRef: 'pi-9', receivableId: null, evidenceRef: 'e9' });
    expect(flowScreen('plan_request', outcome)).toEqual(flowScreen('plan_request', outcome));
  });
});

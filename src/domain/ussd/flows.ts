/**
 * USSD flows — the five SPEC §31 customer flows over injected read-only
 * capability ports (issue #54):
 *
 *   balance_query | invoice_list | statement_query | plan_request | payment_handoff
 *
 * A port is a plain function returning plain data — the lane never imports
 * another domain lane, never touches a store, never writes fund truth. The
 * payments lane keeps payment intake; the plans lane keeps plan truth; this
 * lane only RELAYS what a capability answered, and every answer carries its
 * query's evidenceRef (the audit trail of "what answered, provably").
 *
 * Flow failures are VALUES (`USSD_FLOW_UNAVAILABLE` …) + `ussd.flowFailed`
 * events, never throws: a USSD customer must always get a screen. A port
 * that throws (an adapter bug) is captured and surfaced as unavailability.
 * Malformed port answers (negative amounts, unknown currencies, missing
 * evidence) are refused — deny-by-default, the customer sees the failure
 * screen instead of a wrong number.
 *
 * Money discipline (R1/R2): this lane performs NO money arithmetic — it
 * validates minor units through the shared Money value object and renders
 * its deterministic display string. No cent is created or destroyed.
 */
import { CURRENCIES, DomainError, Money } from '../shared';
import type { Currency, Uuid } from '../shared';
import type { UssdFlowAction, UssdScreen } from './menu';

/** Stable machine codes — adapters match on these, never on strings. */
export const USSD_FLOW_UNAVAILABLE = 'USSD_FLOW_UNAVAILABLE';
export const USSD_FLOW_NOT_WIRED = 'USSD_FLOW_NOT_WIRED';
export const USSD_FLOW_PORT_MALFORMED = 'USSD_FLOW_PORT_MALFORMED';
export const USSD_FLOW_EVIDENCE_REQUIRED = 'USSD_FLOW_EVIDENCE_REQUIRED';
export const USSD_FLOW_LIMIT_INVALID = 'USSD_FLOW_LIMIT_INVALID';
export const USSD_SCREEN_OVERBUDGET = 'USSD_SCREEN_OVERBUDGET';

/** How many invoice lines a list answer shows before it says "and N more". */
export const DEFAULT_INVOICE_LIMIT = 3;

/* ------------------------------------------------------------------ *
 * Ports — injected, read-only, plain data in / plain data out
 * ------------------------------------------------------------------ */

/** What every capability request carries (the session's who + when). */
export interface UssdQueryRequest {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly msisdn: string;
  readonly now: Date;
}

/** Statement queries additionally carry the requested period (may be ''). */
export interface StatementQueryRequest extends UssdQueryRequest {
  readonly period: string;
}

/**
 * A port answer. `available: true` MUST carry a non-blank evidenceRef — an
 * answer without its evidence is refused. `available: false` carries a
 * free-form `reason` (surfaced as USSD_FLOW_UNAVAILABLE detail).
 */
export type UssdPortAnswer<TData> =
  | { readonly available: true; readonly data: TData; readonly evidenceRef: string }
  | { readonly available: false; readonly reason: string };

/** Balance of the customer's ledger account (read-only projection). */
export interface BalanceData {
  readonly amountMinor: number;
  readonly currency: Currency;
}
export interface BalanceQuery {
  (request: UssdQueryRequest): UssdPortAnswer<BalanceData>;
}

/** One open invoice row of the customer's list. */
export interface InvoiceSummary {
  readonly invoiceId: Uuid;
  readonly number: string;
  readonly dueAmountMinor: number;
  readonly currency: Currency;
  /** ISO-8601 date. */
  readonly dueDate: string;
}
export interface InvoiceListData {
  readonly invoices: readonly InvoiceSummary[];
}
export interface InvoiceListQuery {
  (request: UssdQueryRequest): UssdPortAnswer<InvoiceListData>;
}

/** The customer's statement summary for a period. */
export interface StatementData {
  readonly statementRef: string;
  /** ISO-8601 dates. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalInvoicedMinor: number;
  readonly totalPaidMinor: number;
  readonly currency: Currency;
}
export interface StatementQuery {
  (request: StatementQueryRequest): UssdPortAnswer<StatementData>;
}

/**
 * A payment-plan REQUEST intent record. The lane never writes fund or plan
 * truth — the port (backed by the plans lane's intake) returns the intent
 * it recorded; USSD merely carries its ref back to the customer.
 */
export interface PlanIntentData {
  readonly planIntentId: Uuid;
  readonly receivableId: Uuid | null;
}
export interface PlanRequestPort {
  (request: UssdQueryRequest): UssdPortAnswer<PlanIntentData>;
}

/**
 * A payment handoff descriptor. Actual payment intake stays in the payments
 * lane — the descriptor tells the adapter how to walk the customer over
 * (e.g. which invoice, which pay channel), identified by refs only.
 */
export interface PaymentHandoffData {
  readonly handoffRef: string;
  readonly invoiceId: Uuid | null;
  readonly payBy: string | null;
}
export interface PaymentHandoffPort {
  (request: UssdQueryRequest): UssdPortAnswer<PaymentHandoffData>;
}

/* ------------------------------------------------------------------ *
 * Handlers — what the session machine dispatches
 * ------------------------------------------------------------------ */

/** The context a flow handler receives from `respond`. */
export interface UssdFlowContext {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly msisdn: string;
  readonly now: Date;
  readonly args: Readonly<Record<string, string>>;
}

/** The per-flow typed answer (or the refusal) a flow produced. */
export type UssdFlowResult =
  | {
      readonly flow: 'balance_query';
      readonly amountMinor: number;
      readonly currency: Currency;
      /** Deterministic display string from the shared Money value object. */
      readonly display: string;
      readonly evidenceRef: string;
    }
  | {
      readonly flow: 'invoice_list';
      readonly totalAvailable: number;
      readonly shown: number;
      readonly lines: readonly string[];
      readonly evidenceRef: string;
    }
  | {
      readonly flow: 'statement_query';
      readonly statementRef: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly totalInvoicedMinor: number;
      readonly totalPaidMinor: number;
      readonly currency: Currency;
      readonly evidenceRef: string;
    }
  | {
      readonly flow: 'plan_request';
      readonly planIntentRef: string;
      readonly receivableId: Uuid | null;
      readonly evidenceRef: string;
    }
  | {
      readonly flow: 'payment_handoff';
      readonly handoffRef: string;
      readonly invoiceId: Uuid | null;
      readonly payRef: string;
      readonly evidenceRef: string;
    };

/**
 * Flow outcomes are VALUES: `completed` carries the answer, `failed`
 * carries a stable USSD_* code + detail. Neither throws.
 */
export type UssdFlowOutcome =
  | { readonly status: 'completed'; readonly result: UssdFlowResult }
  | { readonly status: 'failed'; readonly code: string; readonly detail: string };

export type UssdFlowHandler = (ctx: UssdFlowContext) => UssdFlowOutcome;

/** What the session machine is wired with — a missing handler is USSD_FLOW_NOT_WIRED. */
export type UssdFlowHandlers = { readonly [F in UssdFlowAction]?: UssdFlowHandler };

/** i18n keys of the flow result screens (defaults; adapters may map them). */
export const DEFAULT_FLOW_TEXT_KEYS: Readonly<Record<UssdFlowAction, string>> = {
  balance_query: 'ussd.flow.balance_query.completed',
  invoice_list: 'ussd.flow.invoice_list.completed',
  statement_query: 'ussd.flow.statement_query.completed',
  plan_request: 'ussd.flow.plan_request.completed',
  payment_handoff: 'ussd.flow.payment_handoff.completed',
};

/** i18n key of the generic flow-failure screen. */
export const FLOW_FAILED_TEXT_KEY = 'ussd.flow.failed';

/* ------------------------------------------------------------------ *
 * Internals — capture, refuse, validate
 * ------------------------------------------------------------------ */

const failed = (code: string, detail: string): UssdFlowOutcome => ({ status: 'failed', code, detail });

const complete = (result: UssdFlowResult): UssdFlowOutcome => ({ status: 'completed', result });

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isSafeNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(new Date(value).getTime());

/** Deterministic display via the shared Money value object (validated upstream). */
const display = (amountMinor: number, currency: Currency): string =>
  Money.ofMinor(amountMinor, currency).toString();

/**
 * Capture a port call: a port that THROWS is an adapter bug, but a USSD
 * customer must still get a screen — surface it as unavailability, never
 * let it escape into the session machine.
 */
const tryPort = <TData>(run: () => UssdPortAnswer<TData>): UssdPortAnswer<TData> => {
  try {
    return run();
  } catch (error) {
    const code = error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'THROWN';
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `port threw ${code}: ${detail}` };
  }
};

type Answered<TData> = { readonly ok: true; readonly data: TData; readonly evidenceRef: string };
type Refused = { readonly ok: false; readonly outcome: UssdFlowOutcome };

/**
 * Screen a port answer: shape → availability → evidence. Deny-by-default —
 * a non-answer or an evidence-less answer is a malformed port result.
 */
const answerOr = <TData>(answer: UssdPortAnswer<TData>): Answered<TData> | Refused => {
  if (!answer || typeof answer !== 'object' || typeof answer.available !== 'boolean') {
    return {
      ok: false,
      outcome: failed(USSD_FLOW_PORT_MALFORMED, 'port returned something that is not a UssdPortAnswer'),
    };
  }
  if (answer.available === false) {
    return {
      ok: false,
      outcome: failed(
        USSD_FLOW_UNAVAILABLE,
        nonBlank(answer.reason) ? answer.reason : 'capability reported unavailable without a reason',
      ),
    };
  }
  if (!nonBlank(answer.evidenceRef)) {
    return {
      ok: false,
      outcome: failed(USSD_FLOW_EVIDENCE_REQUIRED, 'an available answer must carry a non-blank evidenceRef'),
    };
  }
  return { ok: true, data: answer.data, evidenceRef: answer.evidenceRef };
};

const queryOf = (ctx: UssdFlowContext): UssdQueryRequest => ({
  orgId: ctx.orgId,
  customerId: ctx.customerId,
  msisdn: ctx.msisdn,
  now: ctx.now,
});

/* ------------------------------------------------------------------ *
 * The five flows
 * ------------------------------------------------------------------ */

/** F29 "Check balance" over the injected BalanceQuery port. */
export const balanceQueryFlow = (port: BalanceQuery): UssdFlowHandler => (ctx) => {
  const answered = answerOr(tryPort(() => port(queryOf(ctx))));
  if (!answered.ok) return answered.outcome;
  const data = answered.data as unknown as Partial<BalanceData> | null;
  if (!data || typeof data !== 'object') {
    return failed(USSD_FLOW_PORT_MALFORMED, 'balance data is missing');
  }
  if (!isSafeNonNegativeInt(data.amountMinor)) {
    return failed(
      USSD_FLOW_PORT_MALFORMED,
      `balance amountMinor must be a safe non-negative integer, got ${String(data.amountMinor)}`,
    );
  }
  if (!isCurrency(data.currency)) {
    return failed(
      USSD_FLOW_PORT_MALFORMED,
      `balance currency must be one of ${CURRENCIES.join('/')}, got ${String(data.currency)}`,
    );
  }
  const amountMinor = data.amountMinor;
  const currency = data.currency;
  return complete({
    flow: 'balance_query',
    amountMinor,
    currency,
    display: display(amountMinor, currency),
    evidenceRef: answered.evidenceRef,
  });
};

/**
 * F29 "View invoice" over the injected InvoiceListQuery port. Shows up to
 * `limit` lines (default 3); entries beyond the limit are still VALIDATED
 * (deny-by-default) and counted into `totalAvailable`.
 */
export const invoiceListFlow = (
  port: InvoiceListQuery,
  opts: { limit?: number } = {},
): UssdFlowHandler => {
  const limit = opts.limit ?? DEFAULT_INVOICE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DomainError(
      USSD_FLOW_LIMIT_INVALID,
      `invoice list limit must be a safe positive integer, got ${String(limit)}`,
      { limit },
    );
  }
  return (ctx) => {
    const answered = answerOr(tryPort(() => port(queryOf(ctx))));
    if (!answered.ok) return answered.outcome;
    const data = answered.data as unknown as { invoices?: unknown } | null;
    const invoices = data && typeof data === 'object' && Array.isArray(data.invoices) ? data.invoices : null;
    if (!invoices) {
      return failed(USSD_FLOW_PORT_MALFORMED, 'invoice list data.invoices must be an array');
    }
    const lines: string[] = [];
    for (const raw of invoices) {
      const inv = raw as Partial<InvoiceSummary> | null;
      if (!inv || typeof inv !== 'object') {
        return failed(USSD_FLOW_PORT_MALFORMED, 'an invoice entry is missing');
      }
      if (!nonBlank(inv.invoiceId)) {
        return failed(USSD_FLOW_PORT_MALFORMED, 'an invoice entry has a blank invoiceId');
      }
      if (!nonBlank(inv.number)) {
        return failed(USSD_FLOW_PORT_MALFORMED, `invoice '${inv.invoiceId}' has a blank number`);
      }
      if (!isSafeNonNegativeInt(inv.dueAmountMinor)) {
        return failed(
          USSD_FLOW_PORT_MALFORMED,
          `invoice '${inv.number}' has a malformed dueAmountMinor (${String(inv.dueAmountMinor)})`,
        );
      }
      if (!isCurrency(inv.currency)) {
        return failed(USSD_FLOW_PORT_MALFORMED, `invoice '${inv.number}' has a malformed currency`);
      }
      if (!isIsoDate(inv.dueDate)) {
        return failed(USSD_FLOW_PORT_MALFORMED, `invoice '${inv.number}' has a malformed dueDate (ISO-8601 required)`);
      }
      if (lines.length < limit) {
        const currency: Currency = inv.currency;
        const amountMinor: number = inv.dueAmountMinor;
        lines.push(`${inv.number} ${display(amountMinor, currency)} due ${inv.dueDate.slice(0, 10)}`);
      }
    }
    return complete({
      flow: 'invoice_list',
      totalAvailable: invoices.length,
      shown: lines.length,
      lines,
      evidenceRef: answered.evidenceRef,
    });
  };
};

/** F29 "Get statement" over the injected StatementQuery port; `args.period` passes through. */
export const statementQueryFlow = (port: StatementQuery): UssdFlowHandler => (ctx) => {
  const period = nonBlank(ctx.args.period) ? ctx.args.period : '';
  const answered = answerOr(tryPort(() => port({ ...queryOf(ctx), period })));
  if (!answered.ok) return answered.outcome;
  const data = answered.data as unknown as Partial<StatementData> | null;
  if (!data || typeof data !== 'object') {
    return failed(USSD_FLOW_PORT_MALFORMED, 'statement data is missing');
  }
  if (!nonBlank(data.statementRef)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'statement data has a blank statementRef');
  }
  if (!isIsoDate(data.periodStart) || !isIsoDate(data.periodEnd)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'statement period bounds must be ISO-8601 dates');
  }
  if (!isSafeNonNegativeInt(data.totalInvoicedMinor) || !isSafeNonNegativeInt(data.totalPaidMinor)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'statement totals must be safe non-negative integers');
  }
  if (!isCurrency(data.currency)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'statement currency must be one of ' + CURRENCIES.join('/'));
  }
  return complete({
    flow: 'statement_query',
    statementRef: data.statementRef,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    totalInvoicedMinor: data.totalInvoicedMinor,
    totalPaidMinor: data.totalPaidMinor,
    currency: data.currency,
    evidenceRef: answered.evidenceRef,
  });
};

/** F29 "Request payment plan" over the injected PlanRequestPort — relays the intent record. */
export const planRequestFlow = (port: PlanRequestPort): UssdFlowHandler => (ctx) => {
  const answered = answerOr(tryPort(() => port(queryOf(ctx))));
  if (!answered.ok) return answered.outcome;
  const data = answered.data as unknown as Partial<PlanIntentData> | null;
  if (!data || typeof data !== 'object') {
    return failed(USSD_FLOW_PORT_MALFORMED, 'plan intent data is missing');
  }
  if (!nonBlank(data.planIntentId)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'plan intent record has a blank planIntentId');
  }
  if (data.receivableId !== null && data.receivableId !== undefined && !nonBlank(data.receivableId)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'plan intent receivableId must be null or a non-blank id');
  }
  return complete({
    flow: 'plan_request',
    planIntentRef: data.planIntentId,
    receivableId: data.receivableId ?? null,
    evidenceRef: answered.evidenceRef,
  });
};

/** F29 "Pay invoice" handoff over the injected PaymentHandoffPort — relays the descriptor. */
export const paymentHandoffFlow = (port: PaymentHandoffPort): UssdFlowHandler => (ctx) => {
  const answered = answerOr(tryPort(() => port(queryOf(ctx))));
  if (!answered.ok) return answered.outcome;
  const data = answered.data as unknown as Partial<PaymentHandoffData> | null;
  if (!data || typeof data !== 'object') {
    return failed(USSD_FLOW_PORT_MALFORMED, 'payment handoff data is missing');
  }
  if (!nonBlank(data.handoffRef)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'payment handoff descriptor has a blank handoffRef');
  }
  if (data.invoiceId !== null && data.invoiceId !== undefined && !nonBlank(data.invoiceId)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'payment handoff invoiceId must be null or a non-blank id');
  }
  if (data.payBy !== null && data.payBy !== undefined && !nonBlank(data.payBy)) {
    return failed(USSD_FLOW_PORT_MALFORMED, 'payment handoff payBy must be null or a non-blank channel');
  }
  return complete({
    flow: 'payment_handoff',
    handoffRef: data.handoffRef,
    invoiceId: data.invoiceId ?? null,
    payRef: data.payBy ?? '',
    evidenceRef: answered.evidenceRef,
  });
};

/* ------------------------------------------------------------------ *
 * Result → screen
 * ------------------------------------------------------------------ */

/**
 * Deterministic result → screen mapping. The session machine runs this,
 * then enforces the screen budget; an answer that cannot fit the customer's
 * screen is DEMOTED to a failed presentation (USSD_SCREEN_OVERBUDGET) —
 * a wrong number is never shown just because it fits.
 */
export const flowScreen = (flow: UssdFlowAction, outcome: UssdFlowOutcome): UssdScreen => {
  if (outcome.status === 'failed') {
    return { textKey: FLOW_FAILED_TEXT_KEY, params: { code: outcome.code } };
  }
  const result = outcome.result;
  switch (result.flow) {
    case 'balance_query':
      return { textKey: DEFAULT_FLOW_TEXT_KEYS.balance_query, params: { amount: result.display } };
    case 'invoice_list':
      return {
        textKey: DEFAULT_FLOW_TEXT_KEYS.invoice_list,
        params: {
          list: result.lines.join('|'),
          shown: result.shown,
          total: result.totalAvailable,
        },
      };
    case 'statement_query':
      return {
        textKey: DEFAULT_FLOW_TEXT_KEYS.statement_query,
        params: {
          ref: result.statementRef,
          invoiced: display(result.totalInvoicedMinor, result.currency),
          paid: display(result.totalPaidMinor, result.currency),
        },
      };
    case 'plan_request':
      return {
        textKey: DEFAULT_FLOW_TEXT_KEYS.plan_request,
        params: { intent: result.planIntentRef },
      };
    case 'payment_handoff':
      return {
        textKey: DEFAULT_FLOW_TEXT_KEYS.payment_handoff,
        params: { handoff: result.handoffRef, payBy: result.payRef },
      };
  }
};

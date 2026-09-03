/**
 * USSD session state machine (issue #54, SPEC §31).
 *
 * Lifecycle:  started → active → ended | expired | aborted
 *   - a dial-in STARTS a session at the menu root ( USSD sessionStarted);
 *   - the first processed input ACTIVATES it;
 *   - it ENDS on a terminal menu node or a flow disposition
 *     ( USSD sessionEnded), EXPIRES at the idle horizon
 *     ( USSD sessionExpired) or is ABORTED by `#` ( USSD sessionAborted).
 *
 * Expiry: idle TTL from the injected Clock (default 180s), boundary
 * INCLUSIVE — a session is usable only while now < expiresAt, so ±1ms
 * tests are meaningful (same strictly-before convention as auth sessions).
 * The horizon refreshes on every processed input (a mistyped key is still
 * customer activity).
 *
 * `respond(session, input, now, graph, flows?)` is the deterministic step
 * machine. `now` arrives as the injected Clock (a plain Date is accepted
 * for convenience); it is read EXACTLY once per step and every event,
 * stamp and horizon of that step shares the instant. Steps:
 *   - navigation — a menu option moved the session to another node;
 *   - reprompt  — a wrong keypress: USSD_INPUT_INVALID as a VALUE (a wrong
 *     key is a customer event, not a bug), same screen again;
 *   - flow      — a §31 flow dispatched; its outcome (value) and the
 *     session-ending disposition are returned together;
 *   - expired   — the input arrived at/after the idle horizon;
 *   - end       — terminal menu node (menu_exit) or `#` abort.
 *
 * Every step returns the next screen (textKey + params within the graph's
 * screen budget) AND emits its step event(s).
 *
 * Back-navigation (`0` per graph config) replays the append-only
 * inputHistory against the graph to reconstruct the actual trail — pure
 * and deterministic even in graphs where a node has several parents.
 *
 * Purity: no I/O, no RNG, no Date.now() — the Clock is injected. Fresh
 * immutable copies on every transition; inputs are never mutated.
 */
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import { ussdEvent } from './events';
import type {
  FlowCompletedPayload,
  FlowFailedPayload,
  InputRejectedPayload,
  NavigatedPayload,
  SessionAbortedPayload,
  SessionEndedPayload,
  SessionExpiredPayload,
  SessionStartedPayload,
  UssdAnyEvent,
  UssdEvent,
} from './events';
import { flowScreen, USSD_FLOW_NOT_WIRED, USSD_SCREEN_OVERBUDGET } from './flows';
import type { UssdFlowContext, UssdFlowHandlers, UssdFlowOutcome } from './flows';
import { ABORT_KEY, nodeScreen, screenCost } from './menu';
import type { UssdMenuGraph, UssdMenuNode, UssdScreen } from './menu';

/** Default idle TTL: 180 seconds, per the issue. */
export const DEFAULT_USSD_TTL_MS = 180_000;

/** Inputs longer than this are truncated to this cap before anything else. */
export const USSD_INPUT_MAX_CHARS = 8;

/** i18n key of the screen shown when an expired session is hit. */
export const SESSION_EXPIRED_TEXT_KEY = 'ussd.common.session_expired';

/** i18n key of the screen shown after the customer aborts with `#`. */
export const SESSION_ABORTED_TEXT_KEY = 'ussd.common.session_aborted';

export type UssdSessionState = 'started' | 'active' | 'ended' | 'expired' | 'aborted';

export interface UssdSession {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  /** Opaque cross-lane reference — never an import. */
  readonly customerId: Uuid;
  /** Normalized E.164 (+254…). Never enters events or logs. */
  readonly msisdn: string;
  readonly state: UssdSessionState;
  readonly currentNodeKey: string;
  /** Append-only raw keypresses (capped per input) — the back-nav trail replays this. */
  readonly inputHistory: readonly string[];
  readonly ttlMs: number;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly expiresAt: Date;
}

export interface StartUssdSessionArgs {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly msisdn: string;
  /** The menu node the session opens on (the graph's rootKey). */
  readonly rootKey: string;
  readonly ttlMs?: number;
}

/**
 * The deterministic result of one `respond` step. Every variant carries the
 * fresh session copy, the next screen, and its step event(s).
 */
export type UssdStep =
  | {
      readonly kind: 'navigation';
      readonly session: UssdSession;
      readonly screen: UssdScreen;
      readonly event: UssdEvent<'ussd.navigated', NavigatedPayload>;
    }
  | {
      readonly kind: 'reprompt';
      readonly reason: 'USSD_INPUT_INVALID';
      readonly session: UssdSession;
      readonly screen: UssdScreen;
      readonly event: UssdEvent<'ussd.inputRejected', InputRejectedPayload>;
    }
  | {
      readonly kind: 'flow';
      readonly session: UssdSession;
      readonly screen: UssdScreen;
      readonly outcome: UssdFlowOutcome;
      readonly events: readonly [
        UssdEvent<'ussd.flowCompleted', FlowCompletedPayload> | UssdEvent<'ussd.flowFailed', FlowFailedPayload>,
        UssdEvent<'ussd.sessionEnded', SessionEndedPayload>,
      ];
    }
  | {
      readonly kind: 'expired';
      readonly session: UssdSession;
      readonly screen: UssdScreen;
      readonly event: UssdEvent<'ussd.sessionExpired', SessionExpiredPayload>;
    }
  | {
      readonly kind: 'end';
      readonly reason: 'menu_exit' | 'aborted_by_customer';
      readonly session: UssdSession;
      readonly screen: UssdScreen;
      readonly events: readonly UssdAnyEvent[];
    };

/**
 * Accept the injected Clock or a plain instant. One read, validated.
 * USSD_CLOCK_INVALID on a broken clock.
 */
const instantOf = (now: Clock | Date, code: string): Date => {
  const at = now instanceof Date ? now : now.now();
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'the injected clock returned an invalid instant');
  }
  return at;
};

const requireRef = (value: unknown, code: string, what: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError(code, `${what} must be a non-blank string`);
  }
  return value;
};

/**
 * Kenya-first MSISDN normalization to E.164 (+254…). Accepts the shapes
 * Kenyan gateways actually produce:
 *   +254712345678 | 254712345678 | 00254712345678 | 0712345678 | 712345678
 * plus spaces/dashes/dots/parentheses. The subscriber part must be 9 digits
 * starting 7 or 1 (mobile ranges); landline and foreign shapes are refused.
 * Error messages carry NO digits — the raw input never leaks into logs.
 */
export const normalizeMsisdn = (raw: string): string => {
  if (typeof raw !== 'string') {
    throw new DomainError('USSD_MSISDN_INVALID', 'msisdn must be a string');
  }
  const stripped = raw.replace(/[\s\-().]/g, '');
  const match = /^(?:\+254|00254|254|0)?([71]\d{8})$/.exec(stripped);
  if (!match) {
    throw new DomainError(
      'USSD_MSISDN_INVALID',
      'not a normalizable Kenyan MSISDN (expected +254 / 254 / 0 / local shapes, subscriber 9 digits starting 7 or 1)',
      { rawLength: raw.length },
    );
  }
  return `+254${match[1]}`;
};

/**
 * Start a session at the menu root. Emits  USSD sessionStarted — the payload
 * is deliberately narrow: ids + rootKey + instant, NEVER the MSISDN.
 */
export function startUssdSession(
  args: StartUssdSessionArgs,
  now: Clock | Date,
): {
  session: UssdSession;
  event: UssdEvent<'ussd.sessionStarted', SessionStartedPayload>;
} {
  const at = instantOf(now, 'USSD_CLOCK_INVALID');
  const sessionId = requireRef(args.sessionId, 'USSD_SESSION_ID_REQUIRED', 'sessionId') as Uuid;
  const orgId = requireRef(args.orgId, 'USSD_ORG_REQUIRED', 'orgId') as Uuid;
  const customerId = requireRef(args.customerId, 'USSD_CUSTOMER_REQUIRED', 'customerId') as Uuid;
  const rootKey = requireRef(args.rootKey, 'USSD_ROOT_KEY_REQUIRED', 'rootKey');
  const msisdn = normalizeMsisdn(args.msisdn);
  const ttlMs = args.ttlMs ?? DEFAULT_USSD_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new DomainError(
      'USSD_TTL_INVALID',
      `ttlMs must be a safe positive integer of milliseconds, got ${String(ttlMs)}`,
      { ttlMs },
    );
  }
  const session: UssdSession = {
    sessionId,
    orgId,
    customerId,
    msisdn,
    state: 'started',
    currentNodeKey: rootKey,
    inputHistory: Object.freeze([]) as readonly string[],
    ttlMs,
    createdAt: at,
    lastActiveAt: at,
    expiresAt: new Date(at.getTime() + ttlMs),
  };
  return {
    session,
    event: ussdEvent(
      'ussd.sessionStarted',
      sessionId,
      { sessionId, orgId, customerId, rootKey, startedAt: at.toISOString() },
      at,
    ),
  };
}

/**
 * Replay an input history against the graph from the root — reconstructs
 * the node trail (flow dispatches and rejected keys never move the
 * session, and replay mirrors exactly what the machine did at the time).
 * Deterministic even in multi-parent graphs.
 */
export const nodeTrail = (graph: UssdMenuGraph, history: readonly string[]): string[] => {
  const trail: string[] = [graph.rootKey];
  for (const key of history) {
    // Back keys POP the trail — consecutive backs walk up level by level.
    if (key === graph.backKey) {
      if (trail.length > 1) trail.pop();
      continue;
    }
    const node: UssdMenuNode | undefined = graph.nodes[trail[trail.length - 1]!];
    if (!node) break;
    const option = (node.options ?? []).find((o) => o.key === key);
    if (option && option.target.kind === 'node') {
      trail.push(option.target.nodeKey);
    }
  }
  return trail;
};

interface StepStamps {
  readonly state: UssdSessionState;
  readonly lastActiveAt: Date;
  readonly expiresAt: Date;
  readonly inputHistory: readonly string[];
}

const navigationStep = (
  session: UssdSession,
  fromNode: string,
  toNodeKey: string,
  via: string,
  graph: UssdMenuGraph,
  stamps: StepStamps,
  at: Date,
): UssdStep => {
  const target: UssdMenuNode | undefined = graph.nodes[toNodeKey];
  if (!target) {
    throw new DomainError('USSD_MENU_TARGET_UNKNOWN', `navigation target '${toNodeKey}' does not exist in the graph`, {
      nodeKey: toNodeKey,
    });
  }
  const moved: UssdSession = {
    ...session,
    state: stamps.state,
    lastActiveAt: stamps.lastActiveAt,
    expiresAt: stamps.expiresAt,
    currentNodeKey: toNodeKey,
    inputHistory: stamps.inputHistory,
  };
  const navEvent = ussdEvent(
    'ussd.navigated',
    session.sessionId,
    {
      sessionId: session.sessionId,
      orgId: session.orgId,
      customerId: session.customerId,
      fromNode,
      toNode: toNodeKey,
      via,
      navigatedAt: at.toISOString(),
    },
    at,
  );
  if (target.terminal === true) {
    const ended: UssdSession = { ...moved, state: 'ended' };
    return {
      kind: 'end',
      reason: 'menu_exit',
      session: ended,
      screen: nodeScreen(target),
      events: [
        navEvent,
        ussdEvent(
          'ussd.sessionEnded',
          session.sessionId,
          {
            sessionId: session.sessionId,
            orgId: session.orgId,
            customerId: session.customerId,
            reason: 'menu_exit',
            endedAt: at.toISOString(),
          },
          at,
        ),
      ],
    };
  }
  return { kind: 'navigation', session: moved, screen: nodeScreen(target), event: navEvent };
};

const repromptStep = (
  session: UssdSession,
  node: UssdMenuNode,
  key: string,
  stamps: StepStamps,
  at: Date,
): UssdStep => {
  const reprompted: UssdSession = {
    ...session,
    state: stamps.state,
    lastActiveAt: stamps.lastActiveAt,
    expiresAt: stamps.expiresAt,
    inputHistory: stamps.inputHistory,
  };
  return {
    kind: 'reprompt',
    reason: 'USSD_INPUT_INVALID',
    session: reprompted,
    screen: nodeScreen(node),
    event: ussdEvent(
      'ussd.inputRejected',
      session.sessionId,
      {
        sessionId: session.sessionId,
        orgId: session.orgId,
        customerId: session.customerId,
        nodeKey: node.nodeKey,
        input: key,
        rejectedAt: at.toISOString(),
      },
      at,
    ),
  };
};

/**
 * Process one keypress. See the module doc for the step taxonomy. Throws
 * only for ADAPTER bugs (a dead session routed to the machine, a
 * non-string input, a broken clock, a corrupted session/graph pair) —
 * customer-level mistakes come back as re-prompt VALUES.
 */
export function respond(
  session: UssdSession,
  input: string,
  now: Clock | Date,
  graph: UssdMenuGraph,
  flows?: UssdFlowHandlers,
): UssdStep {
  const at = instantOf(now, 'USSD_CLOCK_INVALID');
  if (session.state === 'ended' || session.state === 'expired' || session.state === 'aborted') {
    throw new DomainError(
      'USSD_SESSION_NOT_ACTIVE',
      `session ${session.sessionId} is ${session.state} — terminal sessions accept no input`,
      { sessionId: session.sessionId, state: session.state },
    );
  }
  // Idle expiry, inclusive boundary: usable ⇔ now < expiresAt.
  if (at.getTime() >= session.expiresAt.getTime()) {
    const expired: UssdSession = { ...session, state: 'expired' };
    return {
      kind: 'expired',
      session: expired,
      screen: { textKey: SESSION_EXPIRED_TEXT_KEY },
      event: ussdEvent(
        'ussd.sessionExpired',
        session.sessionId,
        {
          sessionId: session.sessionId,
          orgId: session.orgId,
          customerId: session.customerId,
          idleTtlMs: session.ttlMs,
          expiredAt: at.toISOString(),
        },
        at,
      ),
    };
  }
  const node: UssdMenuNode | undefined = graph.nodes[session.currentNodeKey];
  if (!node) {
    throw new DomainError(
      'USSD_MENU_NODE_UNKNOWN',
      `session ${session.sessionId} points at unknown node '${session.currentNodeKey}'`,
      { nodeKey: session.currentNodeKey },
    );
  }
  if (typeof input !== 'string') {
    throw new DomainError('USSD_INPUT_INVALID', `input must be a string keypress, got ${typeof input}`, {
      inputType: typeof input,
    });
  }
  const key = input.slice(0, USSD_INPUT_MAX_CHARS);
  const history: readonly string[] = [...session.inputHistory, key];
  const stamps: StepStamps = {
    state: session.state === 'started' ? 'active' : session.state,
    lastActiveAt: at,
    expiresAt: new Date(at.getTime() + session.ttlMs),
    inputHistory: history,
  };

  // 1. `#` aborts — always, from any node.
  if (key === ABORT_KEY) {
    const aborted: UssdSession = { ...session, ...stamps, state: 'aborted' };
    return {
      kind: 'end',
      reason: 'aborted_by_customer',
      session: aborted,
      screen: { textKey: SESSION_ABORTED_TEXT_KEY },
      events: [
        ussdEvent(
          'ussd.sessionAborted',
          session.sessionId,
          {
            sessionId: session.sessionId,
            orgId: session.orgId,
            customerId: session.customerId,
            nodeKey: node.nodeKey,
            abortedAt: at.toISOString(),
          },
          at,
        ),
      ],
    };
  }

  // 2. Back navigates up the session's actual trail (replayed from history).
  if (key === graph.backKey) {
    const trail = nodeTrail(graph, session.inputHistory);
    const parentKey = trail.length >= 2 ? trail[trail.length - 2]! : null;
    if (parentKey) {
      return navigationStep(session, node.nodeKey, parentKey, graph.backKey, graph, stamps, at);
    }
    return repromptStep(session, node, key, stamps, at); // at the root: nowhere to back into
  }

  // 3. A menu option: navigate, or dispatch a flow.
  const option = (node.options ?? []).find((o) => o.key === key);
  if (!option) {
    return repromptStep(session, node, key, stamps, at);
  }
  if (option.target.kind === 'node') {
    return navigationStep(session, node.nodeKey, option.target.nodeKey, key, graph, stamps, at);
  }

  // 4. Flow dispatch — failures are values; the disposition ends the session.
  const flow = option.target.flow;
  const handler = flows?.[flow];
  const ctx: UssdFlowContext = {
    orgId: session.orgId,
    customerId: session.customerId,
    msisdn: session.msisdn,
    now: at,
    args: option.target.args ?? Object.freeze({}),
  };
  let outcome: UssdFlowOutcome = handler
    ? handler(ctx)
    : { status: 'failed' as const, code: USSD_FLOW_NOT_WIRED, detail: `no handler wired for flow '${flow}'` };
  let screen = flowScreen(flow, outcome);
  if (screenCost(screen) > graph.screenBudget) {
    // The answer exists but cannot fit the customer's screen — demote the
    // PRESENTATION to a refusal rather than show a truncated/wrong number.
    outcome = {
      status: 'failed',
      code: USSD_SCREEN_OVERBUDGET,
      detail: `the '${flow}' answer does not fit the ${graph.screenBudget}-char screen budget`,
    };
    screen = flowScreen(flow, outcome);
  }
  const flowEvent =
    outcome.status === 'completed'
      ? ussdEvent(
          'ussd.flowCompleted',
          session.sessionId,
          {
            sessionId: session.sessionId,
            orgId: session.orgId,
            customerId: session.customerId,
            flow,
            evidenceRef: outcome.result.evidenceRef,
            completedAt: at.toISOString(),
          },
          at,
        )
      : ussdEvent(
          'ussd.flowFailed',
          session.sessionId,
          {
            sessionId: session.sessionId,
            orgId: session.orgId,
            customerId: session.customerId,
            flow,
            reason: outcome.code,
            detail: outcome.detail,
            failedAt: at.toISOString(),
          },
          at,
        );
  const flowEnded: UssdSession = { ...session, ...stamps, state: 'ended' };
  const endedEvent = ussdEvent(
    'ussd.sessionEnded',
    session.sessionId,
    {
      sessionId: session.sessionId,
      orgId: session.orgId,
      customerId: session.customerId,
      reason: outcome.status === 'completed' ? 'flow_completed' : 'flow_failed',
      endedAt: at.toISOString(),
    },
    at,
  );
  return { kind: 'flow', session: flowEnded, screen, outcome, events: [flowEvent, endedEvent] };
}

/**
 * The sweeper: retire a live session whose idle horizon has passed.
 * Emits  USSD sessionExpired.
 * Throws USSD_SESSION_NOT_DUE while the session is still within its
 * horizon, USSD_SESSION_NOT_ACTIVE once terminal.
 */
export function expireUssdSession(
  session: UssdSession,
  now: Clock | Date,
): {
  session: UssdSession;
  event: UssdEvent<'ussd.sessionExpired', SessionExpiredPayload>;
} {
  const at = instantOf(now, 'USSD_CLOCK_INVALID');
  if (session.state !== 'started' && session.state !== 'active') {
    throw new DomainError(
      'USSD_SESSION_NOT_ACTIVE',
      `session ${session.sessionId} is already ${session.state} — terminals are final`,
      { sessionId: session.sessionId, state: session.state },
    );
  }
  if (at.getTime() < session.expiresAt.getTime()) {
    throw new DomainError(
      'USSD_SESSION_NOT_DUE',
      `session ${session.sessionId} has not reached its idle horizon yet`,
      { sessionId: session.sessionId, expiresAt: session.expiresAt.toISOString() },
    );
  }
  const expired: UssdSession = { ...session, state: 'expired' };
  return {
    session: expired,
    event: ussdEvent(
      'ussd.sessionExpired',
      session.sessionId,
      {
        sessionId: session.sessionId,
        orgId: session.orgId,
        customerId: session.customerId,
        idleTtlMs: session.ttlMs,
        expiredAt: at.toISOString(),
      },
      at,
    ),
  };
}

/**
 * Explicit end (adapter/gateway says the session is over — e.g. the
 * network released the call). Only a live session can be ended.
 * Emits  USSD sessionEnded with the caller's reason.
 */
export function endUssdSession(
  session: UssdSession,
  args: { reason: string },
  now: Clock | Date,
): {
  session: UssdSession;
  event: UssdEvent<'ussd.sessionEnded', SessionEndedPayload>;
} {
  const at = instantOf(now, 'USSD_CLOCK_INVALID');
  const reason = requireRef(args?.reason, 'USSD_REASON_REQUIRED', 'reason');
  if (session.state !== 'started' && session.state !== 'active') {
    throw new DomainError(
      'USSD_SESSION_NOT_ACTIVE',
      `session ${session.sessionId} is already ${session.state} — terminals are final`,
      { sessionId: session.sessionId, state: session.state },
    );
  }
  const ended: UssdSession = { ...session, state: 'ended' };
  return {
    session: ended,
    event: ussdEvent(
      'ussd.sessionEnded',
      session.sessionId,
      {
        sessionId: session.sessionId,
        orgId: session.orgId,
        customerId: session.customerId,
        reason,
        endedAt: at.toISOString(),
      },
      at,
    ),
  };
}

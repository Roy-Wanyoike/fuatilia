/**
 * USSD menu graph — pure configuration (issue #54, SPEC §31).
 *
 * The menu is DATA, not code (policy-lane precedent: rule sets are data).
 * `assertMenuGraph` is the only way to obtain a `UssdMenuGraph`: it
 * validates, deep-copies and deep-freezes the configuration so every later
 * transition works over an immutable snapshot.
 *
 * Validation (deny-by-default, stable USSD_* codes):
 *   - at least one node, unique nodeKeys;
 *   - every node-target resolves; exactly one root;
 *   - every node reachable from the root (no islands);
 *   - every reachable node can EXIT (reach a terminal node, or any flow
 *     option en route — a flow ends the session) — this refuses orphan
 *     cycles and dead-end branches;
 *   - the STATIC screen of every node (its textKey + its option labels)
 *     fits the screen budget — USSD feature phones show ~3×40 chars, so
 *     the default budget is 182 characters (the classic Nokia full screen).
 *
 * i18n: `textKey`s are translation KEYS, never display strings. The adapter
 * renders them against its locale catalog; this lane never sees copy.
 *
 * Reserved keys: `#` always aborts the session and the graph's `backKey`
 * (default `0`) always navigates up — options may never shadow either.
 */
import { DomainError } from '../shared';

/** The abort keypress — fixed by the issue, never shadowable by a menu option. */
export const ABORT_KEY = '#';

/** Default back key — navigates up one level along the session's actual trail. */
export const DEFAULT_BACK_KEY = '0';

/** Default screen budget in characters (classic ~3×40 USSD feature-phone screen). */
export const DEFAULT_SCREEN_BUDGET = 182;

/** The five SPEC §31 flows an option may dispatch. */
export const USSD_FLOW_ACTIONS = [
  'balance_query',
  'invoice_list',
  'statement_query',
  'plan_request',
  'payment_handoff',
] as const;

export type UssdFlowAction = (typeof USSD_FLOW_ACTIONS)[number];

/** Where an option leads: another menu node, or a §31 flow dispatch. */
export type UssdOptionTarget =
  | { readonly kind: 'node'; readonly nodeKey: string }
  | {
      readonly kind: 'flow';
      readonly flow: UssdFlowAction;
      /** Static per-option arguments passed to the flow (e.g. `{ period: 'last_30_days' }`). */
      readonly args?: Readonly<Record<string, string>>;
    };

export interface UssdMenuOption {
  /** 1–2 digits or `*`; `#` and the backKey are reserved. */
  readonly key: string;
  /** i18n key of the option label — never a display string. */
  readonly textKey: string;
  readonly target: UssdOptionTarget;
}

export interface UssdMenuNode {
  readonly nodeKey: string;
  /** i18n key of the node's prompt — never a display string. */
  readonly textKey: string;
  /** Absent/undefined ONLY on a terminal node — its screen ends the session. */
  readonly options?: readonly UssdMenuOption[];
  readonly isRoot?: boolean;
  /** A terminal node shows its screen and ends the session. Carries no options. */
  readonly terminal?: boolean;
}

/**
 * The next screen a step returns: an i18n key plus scalar params. The
 * screen budget is enforced over `textKey` + param keys/values (see
 * `screenCost`) — the deterministic proxy for the rendered text this lane
 * can see; the adapter's locale catalog still owns the final render.
 */
export interface UssdScreen {
  readonly textKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface UssdMenuGraph {
  readonly nodes: Readonly<Record<string, UssdMenuNode>>;
  readonly rootKey: string;
  readonly backKey: string;
  readonly screenBudget: number;
}

export interface AssertMenuGraphConfig {
  readonly backKey?: string;
  readonly screenBudget?: number;
}

const OPTION_KEY_PATTERN = /^[0-9*]{1,2}$/;
const BACK_KEY_PATTERN = /^[0-9*]{1,2}$/;

/**
 * Deterministic screen cost: the textKey's length plus, per param, the
 * key's and value's lengths. Documented proxy — same inputs always cost
 * the same.
 */
export const screenCost = (screen: UssdScreen): number => {
  let cost = screen.textKey.length;
  for (const [key, value] of Object.entries(screen.params ?? {})) {
    cost += key.length + String(value).length;
  }
  return cost;
};

/** The static screen of a menu node — its prompt; the adapter renders options from the graph. */
export const nodeScreen = (node: UssdMenuNode): UssdScreen => ({ textKey: node.textKey });

const assertNonBlankString = (value: unknown, what: string, nodeKey: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('USSD_MENU_NODE_INVALID', `${what} of node '${nodeKey}' must be a non-blank string`, {
      nodeKey,
      what,
    });
  }
};

const freezeOption = (option: UssdMenuOption): UssdMenuOption => {
  const target: UssdOptionTarget =
    option.target.kind === 'flow'
      ? Object.freeze({
          kind: 'flow',
          flow: option.target.flow,
          ...(option.target.args !== undefined
            ? { args: Object.freeze({ ...option.target.args }) }
            : {}),
        })
      : Object.freeze({ kind: 'node', nodeKey: option.target.nodeKey });
  return Object.freeze({ key: option.key, textKey: option.textKey, target });
};

const freezeNode = (node: UssdMenuNode): UssdMenuNode =>
  Object.freeze({
    nodeKey: node.nodeKey,
    textKey: node.textKey,
    options: Object.freeze((node.options ?? []).map(freezeOption)),
    ...(node.isRoot === true ? { isRoot: true } : {}),
    ...(node.terminal === true ? { terminal: true } : {}),
  });

/** Shape pass: node/option fields, key patterns, reserved keys, flow vocabulary. */
const assertNodeShape = (node: UssdMenuNode, backKey: string): void => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new DomainError('USSD_MENU_NODE_INVALID', 'a menu node must be an object');
  }
  const nodeKey = typeof node.nodeKey === 'string' ? node.nodeKey : '?';
  assertNonBlankString(node.nodeKey, 'nodeKey', nodeKey);
  assertNonBlankString(node.textKey, 'textKey', nodeKey);
  if (node.options !== undefined && !Array.isArray(node.options)) {
    throw new DomainError('USSD_MENU_NODE_INVALID', `options of node '${nodeKey}' must be an array`, {
      nodeKey,
    });
  }
  if (node.terminal === true && (node.options ?? []).length > 0) {
    throw new DomainError(
      'USSD_MENU_NODE_INVALID',
      `terminal node '${nodeKey}' must not carry options — its screen ends the session`,
      { nodeKey },
    );
  }
  const seen = new Set<string>();
  for (const option of node.options ?? []) {
    if (!option || typeof option !== 'object') {
      throw new DomainError('USSD_MENU_NODE_INVALID', `node '${nodeKey}' has a malformed option`, { nodeKey });
    }
    const key = typeof option.key === 'string' ? option.key : '';
    assertNonBlankString(key, 'option key', nodeKey);
    assertNonBlankString(option.textKey, `option '${key}' textKey`, nodeKey);
    // Reserved keys are checked BEFORE the shape pattern — '#' is a VALID
    // string whose crime is shadowing the abort key, not its shape.
    if (key === ABORT_KEY) {
      throw new DomainError(
        'USSD_MENU_KEY_RESERVED',
        `option key '${key}' on '${nodeKey}' collides with the abort key — '#' always aborts`,
        { nodeKey, key },
      );
    }
    if (key === backKey) {
      throw new DomainError(
        'USSD_MENU_KEY_RESERVED',
        `option key '${key}' on '${nodeKey}' collides with the back key '${backKey}' — back always navigates up`,
        { nodeKey, key, backKey },
      );
    }
    if (!OPTION_KEY_PATTERN.test(key)) {
      throw new DomainError(
        'USSD_MENU_NODE_INVALID',
        `option key '${key}' on '${nodeKey}' must be 1-2 digits (or *)`,
        { nodeKey, key },
      );
    }
    if (seen.has(key)) {
      throw new DomainError('USSD_MENU_OPTION_DUPLICATE', `option key '${key}' appears twice on node '${nodeKey}'`, {
        nodeKey,
        key,
      });
    }
    seen.add(key);
    const target: UssdOptionTarget | undefined = option.target;
    if (!target || typeof target !== 'object') {
      throw new DomainError('USSD_MENU_NODE_INVALID', `option '${key}' on '${nodeKey}' has no target`, {
        nodeKey,
        key,
      });
    }
    if (target.kind === 'node') {
      assertNonBlankString(target.nodeKey, `target nodeKey of option '${key}'`, nodeKey);
    } else if (target.kind === 'flow') {
      if (!USSD_FLOW_ACTIONS.includes(target.flow)) {
        throw new DomainError(
          'USSD_MENU_FLOW_UNKNOWN',
          `option '${key}' on '${nodeKey}' dispatches unknown flow '${String(target.flow)}' — expected one of ${USSD_FLOW_ACTIONS.join(', ')}`,
          { nodeKey, key, flow: String(target.flow) },
        );
      }
      if (target.args !== undefined) {
        if (!target.args || typeof target.args !== 'object' || Array.isArray(target.args)) {
          throw new DomainError(
            'USSD_MENU_NODE_INVALID',
            `flow args of option '${key}' on '${nodeKey}' must be a string→string record`,
            { nodeKey, key },
          );
        }
        for (const [argKey, argValue] of Object.entries(target.args)) {
          if (argKey.trim().length === 0 || typeof argValue !== 'string') {
            throw new DomainError(
              'USSD_MENU_NODE_INVALID',
              `flow args of option '${key}' on '${nodeKey}' must map non-blank keys to strings`,
              { nodeKey, key, argKey },
            );
          }
        }
      }
    } else {
      throw new DomainError(
        'USSD_MENU_NODE_INVALID',
        `option '${key}' on '${nodeKey}' has target kind '${String((target as { kind?: unknown }).kind)}' — expected 'node' | 'flow'`,
        { nodeKey, key },
      );
    }
  }
};

/**
 * Validate + freeze a menu graph. Throws a stable `USSD_MENU_*` DomainError
 * on the first violation; returns the immutable graph otherwise.
 */
export function assertMenuGraph(
  nodes: readonly UssdMenuNode[],
  config: AssertMenuGraphConfig = {},
): UssdMenuGraph {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new DomainError('USSD_MENU_EMPTY', 'a menu graph requires at least one node');
  }
  const backKey = config.backKey ?? DEFAULT_BACK_KEY;
  if (typeof backKey !== 'string' || backKey === ABORT_KEY || !BACK_KEY_PATTERN.test(backKey)) {
    throw new DomainError(
      'USSD_MENU_BACKKEY_INVALID',
      `backKey must be 1-2 digits (or *), never '${ABORT_KEY}', got ${JSON.stringify(backKey)}`,
      { backKey },
    );
  }
  const screenBudget = config.screenBudget ?? DEFAULT_SCREEN_BUDGET;
  if (!Number.isSafeInteger(screenBudget) || screenBudget <= 0) {
    throw new DomainError(
      'USSD_MENU_BUDGET_INVALID',
      `screenBudget must be a safe positive integer of characters, got ${String(screenBudget)}`,
      { screenBudget },
    );
  }

  // Pass 1 — shapes, reserved keys, duplicate nodeKeys. Freeze as we accept.
  const index: Record<string, UssdMenuNode> = {};
  for (const node of nodes) {
    assertNodeShape(node, backKey);
    if (index[node.nodeKey]) {
      throw new DomainError('USSD_MENU_NODE_DUPLICATE', `nodeKey '${node.nodeKey}' is defined twice`, {
        nodeKey: node.nodeKey,
      });
    }
    index[node.nodeKey] = freezeNode(node);
  }

  // Pass 2 — exactly one root.
  const roots = Object.values(index).filter((n) => n.isRoot === true);
  if (roots.length === 0) {
    throw new DomainError('USSD_MENU_ROOT_REQUIRED', 'exactly one node must be marked isRoot — none was');
  }
  if (roots.length > 1) {
    throw new DomainError(
      'USSD_MENU_ROOT_DUPLICATE',
      `exactly one root allowed, found: ${roots.map((r) => r.nodeKey).join(', ')}`,
    );
  }
  const rootKey = roots[0]!.nodeKey;

  // Pass 3 — every node-target resolves.
  for (const node of Object.values(index)) {
    for (const option of node.options ?? []) {
      if (option.target.kind === 'node' && !index[option.target.nodeKey]) {
        throw new DomainError(
          'USSD_MENU_TARGET_UNKNOWN',
          `option '${option.key}' of '${node.nodeKey}' targets unknown node '${option.target.nodeKey}'`,
          { nodeKey: node.nodeKey, key: option.key, target: option.target.nodeKey },
        );
      }
    }
  }

  // Pass 4 — reachability from the root over node edges (flow options lead out of the menu).
  const reachable = new Set<string>([rootKey]);
  const queue: string[] = [rootKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const option of index[current]!.options ?? []) {
      if (option.target.kind === 'node' && !reachable.has(option.target.nodeKey)) {
        reachable.add(option.target.nodeKey);
        queue.push(option.target.nodeKey);
      }
    }
  }
  const unreachable = Object.keys(index)
    .filter((key) => !reachable.has(key))
    .sort();
  if (unreachable.length > 0) {
    throw new DomainError(
      'USSD_MENU_UNREACHABLE',
      `nodes not reachable from root '${rootKey}': ${unreachable.join(', ')}`,
      { unreachable },
    );
  }

  // Pass 5 — every reachable node can EXIT: reach a terminal node, or any
  // flow option en route (a flow ends the session). Refuses orphan cycles
  // and dead-end branches.
  const exits = new Set<string>();
  for (const [key, node] of Object.entries(index)) {
    if (node.terminal === true || (node.options ?? []).some((o) => o.target.kind === 'flow')) {
      exits.add(key);
    }
  }
  const canExit = new Set<string>(exits);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, node] of Object.entries(index)) {
      if (canExit.has(key)) continue;
      if ((node.options ?? []).some((o) => o.target.kind === 'node' && canExit.has(o.target.nodeKey))) {
        canExit.add(key);
        grew = true;
      }
    }
  }
  const deadEnds = [...reachable].filter((key) => !canExit.has(key)).sort();
  if (deadEnds.length > 0) {
    throw new DomainError(
      'USSD_MENU_DEAD_END',
      `nodes with no terminal screen or flow exit reachable: ${deadEnds.join(', ')}`,
      { deadEnds },
    );
  }

  // Pass 6 — the static screen of every node fits the budget.
  for (const node of Object.values(index)) {
    const cost = node.textKey.length + (node.options ?? []).reduce((n, o) => n + o.key.length + o.textKey.length, 0);
    if (cost > screenBudget) {
      throw new DomainError(
        'USSD_MENU_SCREEN_OVERBUDGET',
        `node '${node.nodeKey}' renders ${cost} chars, over the ${screenBudget}-char screen budget`,
        { nodeKey: node.nodeKey, cost, screenBudget },
      );
    }
  }

  return Object.freeze({
    nodes: Object.freeze(index),
    rootKey,
    backKey,
    screenBudget,
  });
}

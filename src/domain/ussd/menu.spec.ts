import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import {
  ABORT_KEY,
  DEFAULT_BACK_KEY,
  DEFAULT_SCREEN_BUDGET,
  assertMenuGraph,
  nodeScreen,
  screenCost,
  type UssdMenuNode,
} from './menu';

// --- fixtures ---------------------------------------------------------------

/** The §31 demo graph: root menu → flows + submenus → exit. Legal. */
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
        target: { kind: 'flow', flow: 'payment_handoff', args: { invoiceId: 'fixed-by-adapter' } },
      },
    ],
  },
  { nodeKey: 'goodbye', textKey: 'ussd.menu.goodbye', terminal: true },
];

const loose = (value: unknown): UssdMenuNode[] => value as unknown as UssdMenuNode[];

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the happy builder ---------------------------------------------------------

describe('assertMenuGraph — the only constructor', () => {
  it('builds the §31 demo graph and pins the defaults', () => {
    const graph = assertMenuGraph(demoGraph());
    expect(graph.rootKey).toBe('root');
    expect(graph.backKey).toBe(DEFAULT_BACK_KEY);
    expect(graph.backKey).toBe('0');
    expect(graph.screenBudget).toBe(DEFAULT_SCREEN_BUDGET);
    expect(graph.screenBudget).toBe(182);
    expect(Object.keys(graph.nodes).sort()).toEqual(['goodbye', 'invoices', 'pay', 'root']);
    expect(graph.nodes['root']!.isRoot).toBe(true);
    expect(graph.nodes['goodbye']!.terminal).toBe(true);
  });

  it('deep-freezes: graph, index, nodes, options and targets resist mutation', () => {
    const graph = assertMenuGraph(demoGraph());
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes['root'])).toBe(true);
    expect(Object.isFrozen(graph.nodes['root']!.options!)).toBe(true);
    expect(Object.isFrozen(graph.nodes['root']!.options![0]!.target)).toBe(true);
    // strict-mode mutation attempts on frozen structures throw — the graph cannot drift
    expect(() => (graph.nodes['root']!.options! as unknown as unknown[]).push({})).toThrow();
    expect(() => {
      (graph.nodes as unknown as Record<string, unknown>)['rogue'] = {};
    }).toThrow();
  });

  it('an empty (or non-array) node list is refused', () => {
    expectCode(() => assertMenuGraph([]), 'USSD_MENU_EMPTY');
    expectCode(() => assertMenuGraph(undefined as unknown as UssdMenuNode[]), 'USSD_MENU_EMPTY');
  });

  it('a single root-and-terminal node is a legal (one-screen) graph', () => {
    const graph = assertMenuGraph([{ nodeKey: 'only', textKey: 'ussd.menu.only', isRoot: true, terminal: true }]);
    expect(graph.rootKey).toBe('only');
    expect(nodeScreen(graph.nodes['only']!)).toEqual({ textKey: 'ussd.menu.only' });
  });

  it('the same option key may be reused on DIFFERENT nodes', () => {
    const graph = assertMenuGraph(demoGraph());
    expect(graph.nodes['root']!.options!.some((o) => o.key === '1')).toBe(true);
    expect(graph.nodes['invoices']!.options!.some((o) => o.key === '1')).toBe(true);
  });
});

// --- validation tables ------------------------------------------------------

describe('assertMenuGraph — validation refusals (deny-by-default)', () => {
  it('duplicate nodeKeys are refused', () => {
    expectCode(
      () =>
        assertMenuGraph([
          { nodeKey: 'root', textKey: 'ussd.menu.root', isRoot: true, terminal: true },
          { nodeKey: 'root', textKey: 'ussd.menu.copy', terminal: true },
        ]),
      'USSD_MENU_NODE_DUPLICATE',
    );
  });

  it('unresolvable targets are refused — direct and deep', () => {
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: '1', textKey: 'ussd.menu.nowhere', target: { kind: 'node', nodeKey: 'missing' } }],
          },
        ]),
      'USSD_MENU_TARGET_UNKNOWN',
    );
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: '1', textKey: 'ussd.menu.mid', target: { kind: 'node', nodeKey: 'mid' } }],
          },
          {
            nodeKey: 'mid',
            textKey: 'ussd.menu.mid',
            options: [{ key: '1', textKey: 'ussd.menu.deep', target: { kind: 'node', nodeKey: 'deep' } }],
          },
        ]),
      'USSD_MENU_TARGET_UNKNOWN',
    );
  });

  it('exactly one root: none → USSD_MENU_ROOT_REQUIRED, two → USSD_MENU_ROOT_DUPLICATE', () => {
    expectCode(
      () =>
        assertMenuGraph([
          { nodeKey: 'a', textKey: 'ussd.menu.a', terminal: true },
          { nodeKey: 'b', textKey: 'ussd.menu.b', terminal: true },
        ]),
      'USSD_MENU_ROOT_REQUIRED',
    );
    expectCode(
      () =>
        assertMenuGraph([
          { nodeKey: 'a', textKey: 'ussd.menu.a', isRoot: true, terminal: true },
          { nodeKey: 'b', textKey: 'ussd.menu.b', isRoot: true, terminal: true },
        ]),
      'USSD_MENU_ROOT_DUPLICATE',
    );
  });

  it('islands are refused: unreachable node and unreachable subtree both listed', () => {
    try {
      assertMenuGraph([
        { nodeKey: 'root', textKey: 'ussd.menu.root', isRoot: true, terminal: true },
        { nodeKey: 'island', textKey: 'ussd.menu.island', terminal: true },
        {
          nodeKey: 'islandKid',
          textKey: 'ussd.menu.kid',
          options: [{ key: '1', textKey: 'ussd.menu.island', target: { kind: 'node', nodeKey: 'island' } }],
        },
      ]);
      throw new Error('expected USSD_MENU_UNREACHABLE');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('USSD_MENU_UNREACHABLE');
      expect((error as DomainError).details).toMatchObject({ unreachable: ['island', 'islandKid'] });
    }
  });

  it('orphan cycles that dead-end are refused', () => {
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: '1', textKey: 'ussd.menu.loop', target: { kind: 'node', nodeKey: 'a' } }],
          },
          {
            nodeKey: 'a',
            textKey: 'ussd.menu.a',
            options: [{ key: '1', textKey: 'ussd.menu.b', target: { kind: 'node', nodeKey: 'b' } }],
          },
          {
            nodeKey: 'b',
            textKey: 'ussd.menu.b',
            options: [{ key: '1', textKey: 'ussd.menu.a', target: { kind: 'node', nodeKey: 'a' } }],
          },
        ]),
      'USSD_MENU_DEAD_END',
    );
  });

  it('a non-terminal leaf (no options, no exit) is a dead end; a flow option IS an exit', () => {
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: '1', textKey: 'ussd.menu.leaf', target: { kind: 'node', nodeKey: 'leaf' } }],
          },
          { nodeKey: 'leaf', textKey: 'ussd.menu.leaf' },
        ]),
      'USSD_MENU_DEAD_END',
    );
    // the demo graph's `pay` node exits only through a flow option — legal
    expect(() => assertMenuGraph(demoGraph())).not.toThrow();
  });

  it('static screen budget: prompt + option labels must fit; exactly-at-budget is legal', () => {
    const longPrompt = 'x'.repeat(200);
    expectCode(
      () =>
        assertMenuGraph([
          { nodeKey: 'root', textKey: `k${longPrompt}`, isRoot: true, terminal: true },
        ]),
      'USSD_MENU_SCREEN_OVERBUDGET',
    );
    // 182 chars exactly is AT budget (refusal is strictly over): legal; 183 refuses
    expect(() =>
      assertMenuGraph([{ nodeKey: 'root', textKey: 'x'.repeat(182), isRoot: true, terminal: true }], {
        screenBudget: 182,
      }),
    ).not.toThrow();
    expectCode(
      () =>
        assertMenuGraph([{ nodeKey: 'root', textKey: 'x'.repeat(183), isRoot: true, terminal: true }], {
          screenBudget: 182,
        }),
      'USSD_MENU_SCREEN_OVERBUDGET',
    );
    // option labels count toward the node's cost
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'x'.repeat(90),
            isRoot: true,
            options: [
              { key: '1', textKey: 'y'.repeat(92), target: { kind: 'node', nodeKey: 'bye' } },
            ],
          },
          { nodeKey: 'bye', textKey: 'z', terminal: true },
        ]),
      'USSD_MENU_SCREEN_OVERBUDGET',
    );
  });

  it('screenBudget and backKey configuration are validated', () => {
    expectCode(() => assertMenuGraph(demoGraph(), { screenBudget: 0 }), 'USSD_MENU_BUDGET_INVALID');
    expectCode(() => assertMenuGraph(demoGraph(), { screenBudget: -5 }), 'USSD_MENU_BUDGET_INVALID');
    expectCode(() => assertMenuGraph(demoGraph(), { screenBudget: 1.5 }), 'USSD_MENU_BUDGET_INVALID');
    expectCode(() => assertMenuGraph(demoGraph(), { backKey: '#' }), 'USSD_MENU_BACKKEY_INVALID');
    expectCode(() => assertMenuGraph(demoGraph(), { backKey: 'abc' }), 'USSD_MENU_BACKKEY_INVALID');
    expectCode(() => assertMenuGraph(demoGraph(), { backKey: '' }), 'USSD_MENU_BACKKEY_INVALID');
    const graph = assertMenuGraph(demoGraph(), { backKey: '*' });
    expect(graph.backKey).toBe('*');
  });

  it('reserved keys: an option may never shadow # or the backKey', () => {
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: ABORT_KEY, textKey: 'ussd.menu.abort', target: { kind: 'node', nodeKey: 'bye' } }],
          },
          { nodeKey: 'bye', textKey: 'ussd.menu.bye', terminal: true },
        ]),
      'USSD_MENU_KEY_RESERVED',
    );
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [{ key: '0', textKey: 'ussd.menu.zero', target: { kind: 'node', nodeKey: 'bye' } }],
          },
          { nodeKey: 'bye', textKey: 'ussd.menu.bye', terminal: true },
        ]),
      'USSD_MENU_KEY_RESERVED',
    );
    // a custom backKey reserves ITSELF instead
    expectCode(
      () =>
        assertMenuGraph(
          [
            {
              nodeKey: 'root',
              textKey: 'ussd.menu.root',
              isRoot: true,
              options: [{ key: '9', textKey: 'ussd.menu.nine', target: { kind: 'node', nodeKey: 'bye' } }],
            },
            { nodeKey: 'bye', textKey: 'ussd.menu.bye', terminal: true },
          ],
          { backKey: '9' },
        ),
      'USSD_MENU_KEY_RESERVED',
    );
  });

  it('duplicate option keys within one node are refused', () => {
    expectCode(
      () =>
        assertMenuGraph([
          {
            nodeKey: 'root',
            textKey: 'ussd.menu.root',
            isRoot: true,
            options: [
              { key: '1', textKey: 'ussd.menu.one', target: { kind: 'node', nodeKey: 'bye' } },
              { key: '1', textKey: 'ussd.menu.one_again', target: { kind: 'node', nodeKey: 'bye' } },
            ],
          },
          { nodeKey: 'bye', textKey: 'ussd.menu.bye', terminal: true },
        ]),
      'USSD_MENU_OPTION_DUPLICATE',
    );
  });

  it('unknown flow actions are refused', () => {
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'root',
              textKey: 'ussd.menu.root',
              isRoot: true,
              options: [{ key: '1', textKey: 'ussd.menu.weather', target: { kind: 'flow', flow: 'weather_forecast' } }],
            },
          ]),
        ),
      'USSD_MENU_FLOW_UNKNOWN',
    );
  });

  it('node/option shape validation table', () => {
    expectCode(() => assertMenuGraph(loose([{ nodeKey: '', textKey: 't', isRoot: true, terminal: true }])), 'USSD_MENU_NODE_INVALID');
    expectCode(() => assertMenuGraph(loose([{ nodeKey: 'r', textKey: '  ', isRoot: true, terminal: true }])), 'USSD_MENU_NODE_INVALID');
    expectCode(() => assertMenuGraph(loose([{ nodeKey: 'r', textKey: 't', isRoot: true, terminal: true, options: 'nope' }])), 'USSD_MENU_NODE_INVALID');
    expectCode(
      () =>
        assertMenuGraph(
          loose([{ nodeKey: 'r', textKey: 't', isRoot: true, terminal: true, options: [{ key: '1' }] }]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'r',
              textKey: 't',
              isRoot: true,
              options: [{ key: 'abc', textKey: 't', target: { kind: 'node', nodeKey: 'r' } }],
            },
          ]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'r',
              textKey: 't',
              isRoot: true,
              options: [{ key: '1', textKey: 't', target: { kind: 'teleport' } }],
            },
          ]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'root',
              textKey: 'ussd.menu.root',
              isRoot: true,
              // a terminal node carrying options is malformed:
              terminal: true,
              options: [{ key: '1', textKey: 'ussd.menu.x', target: { kind: 'node', nodeKey: 'root' } }],
            },
          ]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
  });

  it('flow args must be a string→string record', () => {
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'root',
              textKey: 'ussd.menu.root',
              isRoot: true,
              options: [
                { key: '1', textKey: 'ussd.menu.stmt', target: { kind: 'flow', flow: 'statement_query', args: { period: 30 } } },
              ],
            },
          ]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
    expectCode(
      () =>
        assertMenuGraph(
          loose([
            {
              nodeKey: 'root',
              textKey: 'ussd.menu.root',
              isRoot: true,
              options: [
                { key: '1', textKey: 'ussd.menu.stmt', target: { kind: 'flow', flow: 'statement_query', args: ['period'] } },
              ],
            },
          ]),
        ),
      'USSD_MENU_NODE_INVALID',
    );
    // valid args build + freeze
    const graph = assertMenuGraph(demoGraph());
    const args = (graph.nodes['pay']!.options![0]!.target as { args?: Record<string, string> }).args;
    expect(args).toEqual({ invoiceId: 'fixed-by-adapter' });
    expect(Object.isFrozen(args)).toBe(true);
  });
});

// --- screen cost ------------------------------------------------------------

describe('screenCost — the deterministic budget proxy', () => {
  it('cost = textKey + Σ (paramKey + value) lengths', () => {
    expect(screenCost({ textKey: 'ussd.flow.failed' })).toBe(16);
    expect(screenCost({ textKey: 'ab', params: { amount: '12.50 KES' } })).toBe(2 + 6 + 9);
    expect(screenCost({ textKey: 'ab', params: {} })).toBe(2);
  });

  it('numbers stringify deterministically', () => {
    expect(screenCost({ textKey: 'x', params: { n: 42 } })).toBe(1 + 1 + 2);
  });
});

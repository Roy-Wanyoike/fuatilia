/**
 * THE contract parity gate of the TS HTTP kernel (issue #132 — the mirror of
 * backend-go's TestServedRoutesMatchOpenAPI): the (method, path) set the TS
 * kernel serves is EXACTLY the operation set api/openapi/fuatilia.v1.yaml
 * declares — no drift in either direction, no missing op, no invented route,
 * on BOTH kernels. A lane that mounts or removes an op without the contract
 * (or vice versa) fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from '../server';
import { InMemoryAuthStore, seedWorld } from '../runtime/memory';
import { InMemoryResourceStore } from '../runtime/resources';
import { systemClock } from '../../../domain/shared';

declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}

const specPath = new URL('../../../../api/openapi/fuatilia.v1.yaml', import.meta.url);

/**
 * Extract the (METHOD path) operation set from the OpenAPI yaml with the
 * same minimal indentation-aware scan backend-go's parity test runs — the
 * contract file is repo-controlled, so the parser only needs the two
 * structural lines: `  /v1/...:` (indent-2 path keys) and
 * `    get|post|...:` (indent-4 operation keys) inside the paths section.
 */
const parseOpenAPIOperations = (): Set<string> => {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
  const operations = new Set<string>();
  let inPaths = false;
  let currentPath = '';
  for (const line of readFileSync(specPath, 'utf8').split('\n')) {
    const trimmed = line.replace(/^ +/, '');
    const indent = line.length - trimmed.length;
    if (indent === 0 && trimmed.endsWith(':')) {
      inPaths = trimmed.startsWith('paths:');
      currentPath = '';
      continue;
    }
    if (!inPaths) continue;
    if (indent === 2 && trimmed.startsWith('/') && trimmed.endsWith(':')) {
      currentPath = trimmed.slice(0, -1);
    } else if (indent === 4 && currentPath !== '') {
      const key = trimmed.slice(0, -1);
      if (methods.has(key)) operations.add(`${key.toUpperCase()} ${currentPath}`);
    }
  }
  return operations;
};

/** `/v1/payments/:paymentId` → `/v1/payments/{paymentId}` (the OpenAPI template). */
const openAPIPathOf = (pattern: string): string =>
  pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');

const servedOperations = (): Set<string> => {
  const store = new InMemoryAuthStore();
  seedWorld(store, systemClock);
  const kernel = createHttpKernel({ store, resourceStore: new InMemoryResourceStore(), clock: systemClock });
  return new Set(kernel.routes.map((route) => `${route.method} ${openAPIPathOf(route.pattern)}`));
};

describe('OpenAPI parity — the served table IS the contract (both kernels)', () => {
  it('the yaml declares the 27 mounted operations (update deliberately, never silently)', () => {
    expect(parseOpenAPIOperations().size).toBe(27);
  });

  it('every declared operation is served and every served route is declared', () => {
    const declared = parseOpenAPIOperations();
    const served = servedOperations();
    const missing = [...declared].filter((op) => !served.has(op)).sort();
    const extra = [...served].filter((op) => !declared.has(op)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(served.size).toBe(declared.size);
  });

  it('the new ledger + adjustments ops ride both the contract and the table', () => {
    const served = servedOperations();
    for (const op of [
      'GET /v1/ledger/accounts',
      'GET /v1/ledger/entries',
      'GET /v1/adjustments',
      'POST /v1/adjustments/credit-notes',
      'POST /v1/adjustments/refund-reservations',
    ]) {
      expect(served.has(op), op).toBe(true);
    }
  });
});

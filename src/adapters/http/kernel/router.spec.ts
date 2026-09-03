import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../domain/shared/errors';
import {
  compileRoute,
  compileRoutes,
  matchRoute,
  methodNotAllowedMessage,
  routeNotFoundMessage,
} from './router';
import type { RouteRecord } from './types';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const route = (method: RouteRecord['method'], pattern: string): RouteRecord => ({
  method,
  pattern,
  handler: () => ({ status: 200, data: { pattern } }),
});

describe('router — pattern matching', () => {
  const compiled = compileRoutes([
    route('GET', '/v1/health'),
    route('POST', '/v1/auth/users'),
    route('GET', '/v1/things/:thingId'),
    route('DELETE', '/v1/things/:thingId'),
    route('GET', '/v1/orgs/:orgId/things/:thingId'),
  ]);

  it('matches a literal route', () => {
    const match = matchRoute(compiled, 'GET', '/v1/health');
    expect(match.matched).toBe(true);
    if (match.matched) {
      expect(match.route.pattern).toBe('/v1/health');
      expect(match.params).toEqual({});
    }
  });

  it('captures :params', () => {
    const match = matchRoute(compiled, 'GET', '/v1/things/abc123');
    expect(match.matched).toBe(true);
    if (match.matched) {
      expect(match.params).toEqual({ thingId: 'abc123' });
    }
  });

  it('captures multiple :params in one pattern', () => {
    const match = matchRoute(compiled, 'GET', '/v1/orgs/org-9/things/thing-1');
    expect(match.matched).toBe(true);
    if (match.matched) {
      expect(match.params).toEqual({ orgId: 'org-9', thingId: 'thing-1' });
    }
  });

  it('tolerates exactly one trailing slash', () => {
    expect(matchRoute(compiled, 'GET', '/v1/health/').matched).toBe(true);
  });

  it('answers 404 for unknown paths, wrong depth, case and non-versioned paths', () => {
    expect(matchRoute(compiled, 'GET', '/v1/nope').matched).toBe(false);
    expect(matchRoute(compiled, 'GET', '/v1/health/extra').matched).toBe(false);
    expect(matchRoute(compiled, 'GET', '/v1/HEALTH').matched).toBe(false);
    expect(matchRoute(compiled, 'GET', '/health').matched).toBe(false);
    expect(matchRoute(compiled, 'GET', '/').matched).toBe(false);
    const miss = matchRoute(compiled, 'GET', '/v1/nope');
    if (!miss.matched) expect(miss.status).toBe(404);
  });

  it('never matches empty segments (// is not a wildcard)', () => {
    expect(matchRoute(compiled, 'GET', '/v1//health').matched).toBe(false);
  });

  it('answers 405 with a sorted allow list when the path exists under other methods', () => {
    const miss = matchRoute(compiled, 'PUT', '/v1/things/t-1');
    expect(miss.matched).toBe(false);
    if (!miss.matched) {
      expect(miss.status).toBe(405);
      expect(miss.allow).toEqual(['DELETE', 'GET']);
    }
  });

  it('messages the transport errors deterministically', () => {
    expect(routeNotFoundMessage('GET', '/v1/nope')).toBe('no route for GET /v1/nope');
    expect(methodNotAllowedMessage('PUT', '/v1/things/t-1', ['DELETE', 'GET'])).toBe(
      'PUT is not allowed for /v1/things/t-1 — allowed: DELETE, GET',
    );
  });
});

describe('router — registration validation (composition-time)', () => {
  it('requires the /v1 prefix', () => {
    expectCode(() => compileRoute(route('GET', '/health')), 'HTTP_ROUTE_PATTERN_INVALID');
    expectCode(() => compileRoute(route('GET', '/v2/health')), 'HTTP_ROUTE_PATTERN_INVALID');
    expectCode(() => compileRoute(route('GET', 'v1/health')), 'HTTP_ROUTE_PATTERN_INVALID');
  });

  it('refuses illegal and empty segments', () => {
    expectCode(() => compileRoute(route('GET', '/v1//health')), 'HTTP_ROUTE_PATTERN_INVALID');
    expectCode(() => compileRoute(route('GET', '/v1/hea lth')), 'HTTP_ROUTE_PATTERN_INVALID');
    expectCode(() => compileRoute(route('GET', '/v1/health!')), 'HTTP_ROUTE_PATTERN_INVALID');
  });

  it('refuses duplicate :param names in one pattern', () => {
    expectCode(() => compileRoute(route('GET', '/v1/x/:id/y/:id')), 'HTTP_ROUTE_PATTERN_INVALID');
  });

  it('refuses duplicate method+pattern rows', () => {
    expectCode(
      () => compileRoutes([route('GET', '/v1/a'), route('GET', '/v1/a')]),
      'HTTP_ROUTE_DUPLICATE',
    );
  });

  it('allows the same pattern under different methods', () => {
    expect(compileRoutes([route('GET', '/v1/a'), route('POST', '/v1/a')])).toHaveLength(2);
  });
});

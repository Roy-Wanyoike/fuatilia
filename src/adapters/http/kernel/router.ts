/**
 * The route table matcher (issue #55, SPEC §38 "Versioned endpoints").
 *
 * Patterns are `/v1/...` with literal segments and `:name` params:
 *
 *     /v1/auth/users            — literal
 *     /v1/auth/users/:userId    — param capture
 *
 * Matching is deterministic: the full path must match one compiled pattern,
 * else 404 `HTTP_ROUTE_NOT_FOUND`; when the path exists under OTHER methods
 * the kernel answers 405 `HTTP_METHOD_NOT_ALLOWED` with an `allow` header
 * listing them (never a bare 404 — that hides routing tables from clients).
 *
 * Registration is validated eagerly (versioned prefix, legal segments, no
 * duplicate params, no duplicate method+pattern) so a broken table fails at
 * composition, not on the wire.
 */
import { DomainError } from '../../../domain/shared/errors';
import {
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_ROUTE_DUPLICATE,
  HTTP_ROUTE_NOT_FOUND,
  HTTP_ROUTE_PATTERN_INVALID,
} from './errors';
import type { HttpMethod, RouteRecord } from './types';

/** Literal segment alphabet (safe in paths and logs). */
const SEGMENT_SHAPE = /^[A-Za-z0-9._~-]+$/;
/** `:name` param segment — the colon is consumed, the name must be sane. */
const PARAM_SHAPE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

/** A route with its pattern pre-split into segments (composition-time). */
export interface CompiledRoute {
  readonly route: RouteRecord;
  readonly segments: readonly string[];
}

/** Compile + validate one route row. Throws `HTTP_ROUTE_PATTERN_INVALID`. */
export function compileRoute(route: RouteRecord): CompiledRoute {
  if (!route.pattern.startsWith('/v1/')) {
    throw new DomainError(
      HTTP_ROUTE_PATTERN_INVALID,
      `route pattern '${route.pattern}' must be versioned under /v1/`,
    );
  }
  const segments = route.pattern.slice(1).split('/');
  const seenParams = new Set<string>();
  for (const segment of segments) {
    const param = PARAM_SHAPE.exec(segment);
    if (param !== null) {
      const name = param[1] ?? '';
      if (seenParams.has(name)) {
        throw new DomainError(
          HTTP_ROUTE_PATTERN_INVALID,
          `route pattern '${route.pattern}' declares ':${name}' twice`,
        );
      }
      seenParams.add(name);
      continue;
    }
    if (!SEGMENT_SHAPE.test(segment)) {
      throw new DomainError(
        HTTP_ROUTE_PATTERN_INVALID,
        `route pattern '${route.pattern}' has an illegal segment '${segment}'`,
      );
    }
  }
  return { route, segments };
}

/** Compile + validate a whole table; duplicate method+pattern rows refuse. */
export function compileRoutes(routes: readonly RouteRecord[]): readonly CompiledRoute[] {
  const compiled = routes.map(compileRoute);
  const seen = new Set<string>();
  for (const { route } of compiled) {
    const key = `${route.method} ${route.pattern}`;
    if (seen.has(key)) {
      throw new DomainError(HTTP_ROUTE_DUPLICATE, `duplicate route '${key}'`);
    }
    seen.add(key);
  }
  return compiled;
}

export type RouteMatch =
  | { readonly matched: true; readonly route: RouteRecord; readonly params: Readonly<Record<string, string>> }
  | { readonly matched: false; readonly status: 404 | 405; readonly allow?: readonly string[] };

/**
 * Match a request against the compiled table. Path matching is
 * case-sensitive; one trailing slash is tolerated (`/v1/health/` ≡
 * `/v1/health`); anything else that no pattern covers is a 404.
 */
export function matchRoute(compiled: readonly CompiledRoute[], method: string, path: string): RouteMatch {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = normalized.startsWith('/') ? normalized.slice(1).split('/') : normalized.split('/');

  const pathMatches: { readonly route: RouteRecord; readonly params: Record<string, string> }[] = [];
  for (const candidate of compiled) {
    if (candidate.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < candidate.segments.length; i++) {
      const patternSegment = candidate.segments[i] ?? '';
      const pathSegment = parts[i] ?? '';
      if (patternSegment.startsWith(':')) {
        params[patternSegment.slice(1)] = pathSegment;
        continue;
      }
      if (patternSegment !== pathSegment) {
        ok = false;
        break;
      }
    }
    if (ok) pathMatches.push({ route: candidate.route, params });
  }

  if (pathMatches.length === 0) {
    return { matched: false, status: 404 };
  }
  const methodMatch = pathMatches.find((m) => m.route.method === method);
  if (methodMatch) {
    return { matched: true, route: methodMatch.route, params: methodMatch.params };
  }
  const allow = [...new Set(pathMatches.map((m) => m.route.method))].sort();
  return { matched: false, status: 405, allow };
}

/** The 405/404 detail the kernel puts in the error envelope. */
export const routeNotFoundMessage = (method: string, path: string): string =>
  `no route for ${method} ${path}`;

export const methodNotAllowedMessage = (method: string, path: string, allow: readonly string[]): string =>
  `${method} is not allowed for ${path} — allowed: ${allow.join(', ')}`;

export type { HttpMethod, RouteRecord };

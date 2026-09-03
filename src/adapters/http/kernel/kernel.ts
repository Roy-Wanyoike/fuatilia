/**
 * The HTTP kernel (issue #55, SPEC §38) — `createKernel` on plain request/
 * response values; the only socket-aware piece is `server.ts`'s `listen`
 * composition, which adapts node:http INTO `handle`.
 *
 * Pipeline per request (deterministic, handler-level testable):
 *   1. lowercase headers; resolve the request id (accept x-request-id /
 *      x-correlation-id, else generate via the injected id port);
 *   2. parse the JSON body against the byte limit (413/400);
 *   3. route: method + /v1 pattern match (404 / 405 + allow header);
 *   4. when the route declares a permission: authenticate (401, audited) then
 *      authorize via can() (403, audited, reason carried);
 *   5. run the handler and wrap its result in the §38 success envelope
 *      `{ data, meta? }`;
 *   6. any DomainError maps through the error table; anything unmapped (or
 *      non-domain) becomes a generic 500 that never leaks internals — the
 *      real error goes to the injected onError sink instead.
 *
 * The request id is echoed on EVERY response (header + error envelope).
 */
import { DomainError } from '../../../domain/shared/errors';
import type { Clock } from '../../../domain/shared/ids';
import type { Principal } from '../../../domain/auth/guard';
import {
  errorBody,
  HTTP_INTERNAL_ERROR,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_ROUTE_NOT_FOUND,
  mapDomainError,
  statusForCode,
} from './errors';
import {
  DEFAULT_MAX_BODY_BYTES,
  normalizeHeaders,
  parseRequestBody,
  resolveRequestId,
  REQUEST_ID_HEADER,
} from './body';
import { compileRoutes, matchRoute, methodNotAllowedMessage, routeNotFoundMessage } from './router';
import { authenticateRequest, authorizeRequest, type AuthPort } from '../middleware/auth';
import type {
  HandlerResult,
  HttpRequest,
  KernelResponse,
  RequestContext,
  RouteRecord,
} from './types';

export interface KernelOptions {
  /** The route registration TABLE (health/meta/auth now; later waves append). */
  readonly routes: readonly RouteRecord[];
  /** Authentication port over the auth lane (sessions + apikeys + guard). */
  readonly auth: AuthPort;
  /** Injected clock — every audited denial timestamp comes from here. */
  readonly clock: Clock;
  /** Injected id port — request ids (and handler-side aggregate ids). */
  readonly idGen: () => string;
  /** JSON body byte limit — default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Observability sink for unmapped/internal errors — NEVER the response. */
  readonly onError?: (error: unknown, requestId: string) => void;
}

export interface Kernel {
  /** The registered table (as given, validated). */
  readonly routes: readonly RouteRecord[];
  readonly maxBodyBytes: number;
  /** Drive one request through the kernel — no sockets, fully deterministic. */
  handle(request: HttpRequest): KernelResponse;
}

export function createKernel(options: KernelOptions): Kernel {
  const routes = compileRoutes(options.routes);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const { auth, clock, idGen, onError } = options;

  const handle = (request: HttpRequest): KernelResponse => {
    const headers = normalizeHeaders(request.headers);
    const requestId = resolveRequestId(headers, idGen);
    const respond = (status: number, body: unknown, extra?: Record<string, string>): KernelResponse => ({
      status,
      requestId,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        [REQUEST_ID_HEADER]: requestId,
        ...(extra ?? {}),
      },
      body,
    });

    try {
      const method = request.method.trim().toUpperCase();
      const parsedBody = parseRequestBody(request.rawBody, maxBodyBytes);
      if (!parsedBody.ok) {
        const mapped = statusForCode(parsedBody.code);
        return respond(mapped, errorBody(parsedBody.code, parsedBody.message, requestId));
      }

      const match = matchRoute(routes, method, request.path);
      if (!match.matched) {
        if (match.status === 405 && match.allow) {
          return respond(
            405,
            errorBody(HTTP_METHOD_NOT_ALLOWED, methodNotAllowedMessage(method, request.path, match.allow), requestId),
            { allow: match.allow.join(', ') },
          );
        }
        return respond(404, errorBody(HTTP_ROUTE_NOT_FOUND, routeNotFoundMessage(method, request.path), requestId));
      }

      let principal: Principal | null = null;
      if (match.route.permission) {
        const authn = authenticateRequest(headers, auth, clock);
        if (!authn.ok) {
          return respond(statusForCode(authn.code), errorBody(authn.code, authn.message, requestId));
        }
        const authz = authorizeRequest(authn.principal, match.route.permission, auth, clock);
        if (!authz.ok) {
          return respond(403, errorBody(authz.code, authz.message, requestId));
        }
        principal = authn.principal;
      }

      const ctx: RequestContext = {
        request,
        params: match.params,
        query: request.query ?? {},
        headers,
        requestId,
        principal,
        body: parsedBody.body,
      };
      const result: HandlerResult = match.route.handler(ctx);
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 299) {
        // Handler contract violation — never surfaced; generic 500 + sink.
        throw new DomainError(
          HTTP_INTERNAL_ERROR,
          `handler for ${method} ${request.path} returned non-2xx status ${String(result.status)}`,
        );
      }
      const successBody =
        result.meta === undefined
          ? { data: result.data ?? null }
          : { data: result.data ?? null, meta: result.meta };
      return respond(result.status, successBody);
    } catch (error) {
      if (error instanceof DomainError) {
        const mapped = mapDomainError(error);
        if (mapped.internal && onError) onError(error, requestId);
        return respond(mapped.status, errorBody(mapped.code, mapped.message, requestId));
      }
      if (onError) onError(error, requestId);
      return respond(500, errorBody(HTTP_INTERNAL_ERROR, 'internal server error', requestId));
    }
  };

  return {
    routes: routes.map((c) => c.route),
    maxBodyBytes,
    handle,
  };
}

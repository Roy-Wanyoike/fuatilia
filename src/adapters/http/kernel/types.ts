/**
 * HTTP kernel wire shapes (issue #55, SPEC §38 "API DESIGN").
 *
 * The kernel is the FIRST transport lane: it mounts the completed domain core
 * behind a versioned `/v1` JSON surface. Handlers receive a fully-parsed
 * `RequestContext` (params/query/headers/body + the resolved Principal) and
 * return a plain `HandlerResult`; the kernel owns everything cross-cutting —
 * request ids, body limits, routing, authentication/authorization, the
 * response envelope and the domain-error → status mapping.
 *
 * Handlers are SYNCHRONOUS on purpose: the kernel is deterministic and
 * handler-level testable with synthetic requests (no sockets). Persistence-
 * backed adapters hide their I/O behind the injected ports (see
 * `../runtime/memory.ts` for the in-memory reference implementation).
 */
import type { Principal } from '../../../domain/auth/guard';
import type { Permission } from '../../../domain/auth/roles';

/** The HTTP methods the router understands (kernel uppercases on entry). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A synthetic or adapted request. `rawBody` is the DECODED UTF-8 text the
 * kernel parses as JSON (size-limited); `query`/`headers` are flat string
 * maps (the kernel lowercases header names).
 */
export interface HttpRequest {
  readonly method: string;
  /** Path only, e.g. `/v1/health` — query lives in `query`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: string | undefined;
}

/** Everything a handler may touch. `principal` is null on no-auth routes. */
export interface RequestContext {
  readonly request: HttpRequest;
  /** `:param` values extracted by the router. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Lowercased header map (as seen by the kernel). */
  readonly headers: Readonly<Record<string, string>>;
  /** Accepted-or-generated request id — echoed on every response. */
  readonly requestId: string;
  readonly principal: Principal | null;
  /** Parsed JSON body (`undefined` when the request carried none). */
  readonly body: unknown;
}

/**
 * A handler outcome. The kernel wraps `data`/`meta` into the §38 success
 * envelope `{ data, meta? }`; failures are thrown as `DomainError` and mapped
 * by the kernel's error table — handlers never build error envelopes.
 */
export interface HandlerResult {
  /** Must be 2xx — anything else is a handler bug and surfaces as a 500. */
  readonly status: number;
  readonly data?: unknown;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type Handler = (ctx: RequestContext) => HandlerResult;

/**
 * One row of the route registration TABLE (issue #55): later waves mount
 * more resources by appending rows — no kernel file changes. `permission`
 * absent/undefined = public route (no authentication is attempted at all);
 * present = the route requires an authenticated Principal holding it.
 */
export interface RouteRecord {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly permission?: Permission | undefined;
  readonly handler: Handler;
}

/**
 * The kernel's response: `body` is the full §38 envelope (success
 * `{ data, meta? }`; error `{ error: { code, message }, requestId }`), the
 * request id is echoed both as a top-level field and as the `x-request-id`
 * header so every response is correlatable.
 */
export interface KernelResponse {
  readonly status: number;
  readonly requestId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

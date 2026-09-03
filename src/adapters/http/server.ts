/**
 * Composition root of the HTTP lane (issue #55): mounts the route table over
 * the auth lane and adapts node:http INTO the kernel's value-shaped
 * `handle`. This is the ONLY socket-aware file in the lane; `kernel.handle`
 * itself stays deterministic and handler-testable.
 *
 * Defaults: system clock, `crypto.randomUUID` id port, 1 MiB body cap and an
 * empty in-memory auth store. Use `seedWorld` (runtime/memory.ts) to get a
 * usable admin principal in tests/local composition.
 *
 * node:http adaptation notes (deliberate, documented): headers arrive
 * lowercased from node; the query string parses via `URL`; the body is
 * consumed chunk-wise and decoded as UTF-8 text (the kernel contract takes
 * DECODED text — integration payloads are ASCII; a binary-safe transport
 * adapter is a later wave). An over-limit body is NEVER buffered: the size
 * counter trips first and a stub payload of the observed size is handed to
 * the kernel so it deterministically answers 413.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID as freshUuid } from 'node:crypto';
import { systemClock, type Clock } from '../../domain/shared/ids';
import { createKernel, type Kernel } from './kernel/kernel';
import type { HttpRequest, KernelResponse, RouteRecord } from './kernel/types';
import { authPortFromStore, InMemoryAuthStore, type AuthStore } from './runtime/memory';
import { authRoutes } from './routes/auth';
import { healthRoute, metaRoute } from './routes/public';

export interface HttpKernelOptions {
  /** Injected clock (default: system). Feeds every audited denial timestamp. */
  readonly clock?: Clock;
  /** Injected id port — MUST produce UUIDs (default: crypto.randomUUID). */
  readonly idGen?: () => string;
  /** JSON body byte cap (default 1 MiB). */
  readonly maxBodyBytes?: number;
  /** Auth-lane state (default: a fresh empty in-memory store). */
  readonly store?: AuthStore;
  /** Observability sink for internal errors — never the response body. */
  readonly onError?: (error: unknown, requestId: string) => void;
}

export interface ListenedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** Awaitable close for tests (the repo's only socket test). */
  close(): Promise<void>;
}

export interface HttpKernel {
  /** Drive synthetic requests without sockets (deterministic tests). */
  handle(request: HttpRequest): KernelResponse;
  /** The mounted route table. */
  readonly routes: readonly RouteRecord[];
  /** The auth-lane state backing the routes (seed/inspect in tests). */
  readonly store: AuthStore;
  /** Spin the real node:http server (port 0 = ephemeral). */
  listen(port?: number): Promise<ListenedServer>;
}

export function createHttpKernel(options: HttpKernelOptions = {}): HttpKernel {
  const store = options.store ?? new InMemoryAuthStore();
  const clock = options.clock ?? systemClock;
  const idGen = options.idGen ?? freshUuid;
  const maxBodyBytes = options.maxBodyBytes;

  // Auth lane → kernel ports.
  const auth = authPortFromStore(store, clock);

  // Route table: public rows + the /v1/auth admin table (later waves append).
  const adminTable = authRoutes({ store, clock, idGen });
  const capabilities = [
    ...new Set(adminTable.map((route) => route.pattern.split('/')[2] ?? '').filter((s) => s !== '')),
  ].sort();
  const routes: readonly RouteRecord[] = [healthRoute(), metaRoute(capabilities), ...adminTable];

  const kernel: Kernel = createKernel({
    routes,
    auth,
    clock,
    idGen,
    maxBodyBytes,
    onError: options.onError,
  });

  const listen = (port = 0): Promise<ListenedServer> =>
    new Promise((resolve) => {
      const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let raw = '';
        let size = 0;
        let tooLarge = false;
        const cap = kernel.maxBodyBytes;

        req.on('data', (chunk: unknown) => {
          size += String(chunk).length;
          if (size > cap) {
            tooLarge = true;
            raw = '';
            return;
          }
          if (!tooLarge) raw += String(chunk);
        });

        req.on('end', () => {
          const query: Record<string, string> = {};
          url.searchParams.forEach((value, name) => {
            query[name] = value;
          });
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers[name] = value;
            else if (Array.isArray(value) && value.length > 0) headers[name] = String(value[value.length - 1]);
          }
          const response = kernel.handle({
            method: req.method ?? 'GET',
            path: url.pathname,
            query,
            headers,
            rawBody: tooLarge ? ' '.repeat(Math.min(size, cap + 1)) : raw === '' ? undefined : raw,
          });
          res.writeHead(response.status, { ...response.headers });
          res.end(JSON.stringify(response.body));
        });
      });

      server.listen(port, () => {
        const address = server.address();
        const bound = typeof address === 'object' && address !== null ? address.port : port;
        resolve({
          server,
          port: bound,
          url: `http://127.0.0.1:${bound}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });

  return { handle: kernel.handle, routes: kernel.routes, store, listen };
}

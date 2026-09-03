/**
 * Minimal ambient surface for the node built-ins this lane's COMPOSITION
 * uses (`server.ts` + the runtime codec). The lane carries ZERO npm
 * dependencies — rather than adding @types/node, we declare exactly the API
 * we call. The kernel itself (`kernel/*`, `pagination.ts`, `middleware/`)
 * stays node-free and value-shaped; only `listen()` touches sockets and only
 * the reference codec touches crypto.
 */

declare module 'node:http' {
  export interface IncomingMessage {
    readonly url?: string | undefined;
    readonly method?: string | undefined;
    readonly headers: Record<string, string | string[] | undefined>;
    on(event: string, listener: (chunk: unknown) => void): unknown;
  }
  export interface ServerResponse {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body: string): unknown;
  }
  export interface Server {
    listen(port: number, onListening: () => void): void;
    close(onClosed: () => void): void;
    address(): { port: number } | string | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string, encoding?: string): { digest(encoding?: string): string };
  };
  export function randomUUID(): string;
}

/** URL lives outside lib ES2022 — declare the slice server.ts uses. */
declare class URLSearchParams {
  forEach(callback: (value: string, name: string) => void): void;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

/** Global fetch (Node ≥18) — the slice the single integration spec uses. */
declare function fetch(
  input: string,
  init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string },
): Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

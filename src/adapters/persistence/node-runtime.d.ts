/**
 * Minimal ambient surface for the node built-ins the persistence lane uses
 * (issue #61, F32). The lane carries ZERO npm dependencies — following the
 * HTTP lane's precedent (`../http/node-runtime.d.ts`), we declare exactly the
 * API we call rather than adding @types/node. Only this lane's composition
 * files touch the filesystem: the journal, the store and the specs.
 */

declare module 'node:fs/promises' {
  export interface FileHandle {
    writeFile(data: string, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<string | undefined>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
}

declare module 'node:path' {
  export function join(...segments: readonly string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

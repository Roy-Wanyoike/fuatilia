/**
 * Shared identity primitives.
 *
 * Wave-1 modules communicate ONLY through opaque ids — never by importing
 * another module's entity types (see src/domain/<module>/README.md).
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Opaque unique identifier (UUID-shaped in production adapters). */
export type Uuid = Brand<string, 'Uuid'>;

export const uuid = (raw: string): Uuid => {
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) {
    throw new Error(`invalid uuid: ${raw}`);
  }
  return raw as Uuid;
};

/** Port for time — inject a fake clock in tests; never call Date.now() in the core. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Structural revival for the PG persistence adapters (issue #73) — the SQL→
 * domain-row boundary, mirroring the read-half discipline of
 * `../replay.ts`: revive STRUCTURALLY (no domain re-validation — the writer
 * validated; boot checks integrity), and every row that does not fit its
 * domain shape is QUARANTINED with a reason instead of fabricated, thrown,
 * or allowed to poison the boot.
 *
 * This module holds only the shared accessors and the `Revival` result; the
 * per-aggregate revivers live beside their stores (authstore.ts /
 * resourcestore.ts) where their column maps live.
 */

/** One row failed structural revival — the whole row is quarantined. */
export class RowFormatError extends Error {}

/** `revive*` returns the domain row, or the REASON the row is quarantined. */
export type Revival<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly reason: string };

/** Run a structural reviver, converting any rejection into a quarantine reason. */
export const revival = <T>(revive: () => T): Revival<T> => {
  try {
    return { ok: true, row: revive() };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof RowFormatError ? error.message : `unexpected revival failure: ${String(error)}`,
    };
  }
};

/** A driver row, viewed as the structural record revival reads. */
export type Row = Record<string, unknown>;

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const asDate = (value: unknown): Date | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

export const requiredString = (row: Row, key: string): string => {
  const value = asString(row[key]);
  if (value === null) throw new RowFormatError(`field '${key}' must be a string`);
  return value;
};

export const requiredDate = (row: Row, key: string): Date => {
  const value = asDate(row[key]);
  if (value === null) throw new RowFormatError(`field '${key}' must be a timestamp`);
  return value;
};

export const nullableString = (row: Row, key: string): string | null => {
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  const value = asString(raw);
  if (value === null) throw new RowFormatError(`field '${key}' must be a string or null`);
  return value;
};

export const nullableDate = (row: Row, key: string): Date | null => {
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  const value = asDate(raw);
  if (value === null) throw new RowFormatError(`field '${key}' must be a timestamp or null`);
  return value;
};

export const requiredStringArray = (row: Row, key: string): string[] => {
  const raw = row[key];
  if (!Array.isArray(raw)) throw new RowFormatError(`field '${key}' must be a text[]`);
  return raw.map((entry) => {
    if (typeof entry !== 'string') throw new RowFormatError(`field '${key}' must hold strings`);
    return entry;
  });
};

export const asBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

export const requiredBoolean = (row: Row, key: string): boolean => {
  const value = asBoolean(row[key]);
  if (value === null) throw new RowFormatError(`field '${key}' must be a boolean`);
  return value;
};

/** A jsonb column revived as an arbitrary JSON value (anything but undefined). */
export const requiredJson = (row: Row, key: string): unknown => {
  const value = row[key];
  if (value === undefined) throw new RowFormatError(`field '${key}' must be a jsonb value`);
  return value;
};

export const requiredEnum = <T extends string>(row: Row, key: string, allowed: readonly T[]): T => {
  const raw = row[key];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new RowFormatError(`field '${key}' must be one of ${allowed.join(' | ')}`);
  }
  return raw as T;
};

/**
 * A bigint minor-units column (R10: money NEVER travels as float) → the
 * exact integer as a JS bigint. pg delivers int8 as a string; anything else
 * (or a non-digit) is a revival failure, never a silent coercion.
 */
export const requiredMinorUnits = (row: Row, key: string): bigint => {
  const raw = row[key];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new RowFormatError(`field '${key}' must be a non-negative bigint (minor units)`);
  }
  return BigInt(raw);
};

/** Optional variant — NULL is legal, garbage is not. */
export const nullableMinorUnits = (row: Row, key: string): bigint | null => {
  const raw = row[key];
  if (raw === null || raw === undefined) return null;
  return requiredMinorUnits(row, key);
};

export const requiredSafePositiveInt = (row: Row, key: string): number => {
  const raw = row[key];
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RowFormatError(`field '${key}' must be a safe positive integer`);
  }
  return value;
};

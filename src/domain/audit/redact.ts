/**
 * Redaction discipline (issue #53, SPEC §37) — the audit lane's data-minimisation gate.
 *
 * previousState/newState snapshots are raw domain state, and raw state carries
 * credentials: passwords, API-key secrets, M-Pesa tokens, authorization
 * headers, PINs. NONE of that may ever reach the append-only trail, so
 * redaction runs BEFORE persistence — inside the record builder AND again
 * inside the sink (defense in depth: a caller that bypasses the builder and
 * appends straight into the sink still cannot persist a secret). The hash
 * chain then covers the REDACTED form, so what `verifyChain` attests is
 * exactly what was stored — a redaction bypass would be visible as a broken
 * chain.
 *
 * Semantics:
 *   - a key is forbidden when its LOWERCASED form CONTAINS any forbidden word
 *     (`password | secret | token | apikey | authorization | pin`) — so
 *     `Password`, `SECRET`, `apiKey` are caught by the letter of the spec AND
 *     `client_secret`, `access_token`, `api_key`, `PIN_code` by its spirit.
 *     Over-redaction ('tokenize' loses its entry) is the accepted safe
 *     default: a stripped legitimate field is an annoyance; a persisted
 *     credential is an incident. Callers keep such data out of snapshots.
 *   - forbidden entries are STRIPPED (the key disappears), never masked — a
 *     masked value would still confirm the key's existence and shape.
 *   - inputs are never mutated: the function returns a fresh deep copy.
 *   - outputs are deep-frozen: the trail's snapshots are immutable facts.
 *   - structure is validated on the way through (plain objects/arrays/
 *     scalars only — Dates, class instances, bigints, `undefined` members,
 *     non-finite numbers, cycles and over-deep nesting are refused with the
 *     stable AUDIT_SNAPSHOT_INVALID): snapshots must survive canonical-JSON
 *     hashing losslessly.
 *
 * Pure: no I/O, no RNG, no clock reads.
 */
import { DomainError } from '../shared';

/** The forbidden vocabulary (SPEC §37 + issue #53) — matched case-insensitively. */
export const FORBIDDEN_KEYS = [
  'password',
  'secret',
  'token',
  'apikey',
  'authorization',
  'pin',
] as const;

/** Snapshots must stay shallow enough to hash — deep nesting is a modelling smell. */
export const MAX_SNAPSHOT_DEPTH = 24;

const isForbiddenKey = (key: string): boolean => {
  // separators dissolve before matching: api_key / api-key / api.key === apikey
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return FORBIDDEN_KEYS.some((word) => normalized.includes(word));
};

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const invalid = (path: string, why: string): DomainError =>
  new DomainError(
    'AUDIT_SNAPSHOT_INVALID',
    `snapshot${path ? ` at "${path}"` : ''}: ${why}`,
    { path: path || '(root)' },
  );

/** Structural validation — everything redaction and canonical JSON can represent losslessly. */
export const validateSnapshotShape = (value: unknown, path = '', depth = 0, seen = new Set<object>()): void => {
  if (depth > MAX_SNAPSHOT_DEPTH) throw invalid(path, `nesting exceeds ${MAX_SNAPSHOT_DEPTH} levels`);
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw invalid(path, `non-finite number ${String(value)} would not round-trip`);
      return;
    case 'bigint':
      throw invalid(path, 'bigint is not JSON-serializable — convert minor units to safe numbers first');
    case 'undefined':
      throw invalid(path, 'undefined is not JSON-serializable (silently dropped on the wire)');
    case 'function':
    case 'symbol':
      throw invalid(path, `${typeof value} is not JSON-serializable`);
    case 'object': {
      if (seen.has(value)) throw invalid(path, 'circular reference');
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => validateSnapshotShape(item, `${path}[${index}]`, depth + 1, seen));
      } else if (isPlainObject(value)) {
        for (const [key, member] of Object.entries(value)) {
          if (member === undefined) throw invalid(path ? `${path}.${key}` : key, 'undefined member (would be silently dropped)');
          validateSnapshotShape(member, path ? `${path}.${key}` : key, depth + 1, seen);
        }
      } else {
        const kind = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
        throw invalid(path, `${kind} instances are not snapshot material — use ids, ISO strings and scalars`);
      }
      seen.delete(value); // DAG sharing allowed, cycles not
      return;
    }
  }
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * Strip forbidden keys recursively and return a fresh, deep-frozen copy.
 * Never mutates the input; refuses structurally invalid input (see
 * `validateSnapshotShape`) — a snapshot that cannot be hashed losslessly is
 * a caller bug, not a redaction concern.
 */
export function redactSnapshot<T>(value: T, path = '', seen = new Set<object>()): T {
  validateSnapshotShape(value, path);
  return deepFreeze(redact(value, path, seen)) as T;
}

const redact = (value: unknown, path: string, seen: Set<object>): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw invalid(path, 'circular reference');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => redact(item, `${path}[${index}]`, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (!isForbiddenKey(key)) out[key] = redact(member, path ? `${path}.${key}` : key, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
};

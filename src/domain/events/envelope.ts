/**
 * Envelope — the stable wire contract for every Fuatilia domain event.
 *
 * Contract (src/domain/events/README.md + docs/04-event-catalog.md):
 *   { eventId, name, version, occurredAt, aggregateId, correlationId?, payload }
 *
 * - `name` MUST be one of the 27 catalog events (docs/04); `makeEnvelope` is the
 *   only sanctioned constructor and refuses anything else (EVENT_UNKNOWN).
 * - `version` is the payload schema version; the catalog ships every event at
 *   version 1 — breaking payload changes bump it (guarded by `defineEvent`).
 * - `occurredAt` is an ISO-8601 string normalized from the caller's injected
 *   Clock (`clock.now()`) — this module never reads the wall clock itself.
 * - `payload` is narrow and serializable: ids/scalars only, no entity
 *   references, no bigints (minor units travel as safe-integer numbers — see
 *   `minorUnits` in catalog.ts), no Dates (ISO strings), no functions/symbols.
 *
 * Wave-1 modules (receivables/payments/adjustments) still emit their own plain
 * envelopes; this module is the unified contract they migrate onto (issue #6).
 */
import { DomainError } from '../shared';
import type { Uuid } from '../shared';
import { EVENT_VERSIONS, isEventName } from './catalog';
import type { EventName, PayloadOf } from './catalog';

/** The stable envelope — identical on the wire for every event in the catalog. */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  /** Unique, assigned at creation (adapter mints it); the outbox dedupes on it. */
  readonly eventId: Uuid;
  /** Catalog name, e.g. 'payment.confirmed'. */
  readonly name: TName;
  /** Payload schema version — breaking payload changes bump this. */
  readonly version: 1;
  /** ISO-8601, from the injected Clock — never Date.now() inside the core. */
  readonly occurredAt: string;
  /** Owning aggregate. */
  readonly aggregateId: Uuid;
  /** Ties a journey (e.g. one payment's whole lifecycle) together. */
  readonly correlationId?: Uuid;
  /** Narrow, serializable, ids only — never an entity reference. */
  readonly payload: TPayload;
}

/** Constructor inputs for `makeEnvelope` — ids + a Clock-derived timestamp. */
export interface EnvelopeOptions {
  readonly eventId: Uuid;
  readonly aggregateId: Uuid;
  readonly correlationId?: Uuid;
  /** A `Date` (typically `clock.now()`) or a pre-formatted ISO-8601 string. */
  readonly occurredAt: Date | string;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** `<context>.<aggregate><PastTenseVerb>` in lowerCamelCase, exactly one dot. */
export const EVENT_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$/;

/** Validates a UUID-shaped id (canonical 8-4-4-4-12 hex) with a stable code. */
const assertUuid = (value: Uuid, field: string): Uuid => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError('EVENT_ID_INVALID', `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value;
};

/** Validates + normalizes occurredAt: Date → ISO-8601 string; ISO string passes through. */
const normalizeOccurredAt = (input: Date | string): string => {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new DomainError('EVENT_OCCURRED_AT_INVALID', 'occurredAt is an invalid Date', {
        occurredAt: String(input),
      });
    }
    return input.toISOString();
  }
  if (typeof input === 'string' && ISO_PATTERN.test(input) && !Number.isNaN(new Date(input).getTime())) {
    return input;
  }
  throw new DomainError(
    'EVENT_OCCURRED_AT_INVALID',
    `occurredAt must be ISO-8601 (e.g. 2025-09-02T08:00:00.000Z), got ${String(input)}`,
    { occurredAt: String(input) },
  );
};

/** Payload members must survive a JSON round-trip — silently lossy values are refused. */
const notSerializable = (path: string, why: string): DomainError =>
  new DomainError('EVENT_PAYLOAD_NOT_SERIALIZABLE', `payload${path ? ` at "${path}"` : ''}: ${why}`, {
    path: path || '(root)',
  });

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const MAX_PAYLOAD_DEPTH = 24; // payloads are flat records — deep nesting is a modelling smell

const assertMemberSerializable = (value: unknown, path: string, depth: number, seen: Set<object>): void => {
  if (depth > MAX_PAYLOAD_DEPTH) throw notSerializable(path, `nesting exceeds ${MAX_PAYLOAD_DEPTH} levels`);
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw notSerializable(path, `non-finite number ${String(value)} would become null`);
      return;
    case 'bigint':
      throw notSerializable(path, 'bigint is not JSON-serializable — convert minor units with minorUnits()');
    case 'function':
    case 'symbol':
    case 'undefined':
      throw notSerializable(path, `${typeof value} is not JSON-serializable (silently dropped on the wire)`);
    case 'object': {
      if (value === null) return;
      if (seen.has(value)) throw notSerializable(path, 'circular reference');
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertMemberSerializable(item, `${path}[${index}]`, depth + 1, seen));
      } else if (isPlainObject(value)) {
        for (const [key, member] of Object.entries(value)) {
          assertMemberSerializable(member, path ? `${path}.${key}` : key, depth + 1, seen);
        }
      } else {
        const kind = value.constructor?.name ?? 'object';
        throw notSerializable(path, `${kind} instances are not serializable — use ids, ISO strings and scalars`);
      }
      seen.delete(value); // DAG sharing allowed, cycles not
      return;
    }
  }
};

/** Payload must be a plain, JSON-serializable object (the wire is JSON). */
export function assertSerializablePayload(payload: unknown): void {
  if (payload === undefined || payload === null) {
    throw new DomainError('EVENT_PAYLOAD_REQUIRED', 'payload is required — use an empty object {} if an event carries no fields');
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw notSerializable('', `payload must be a plain object, got ${Array.isArray(payload) ? 'array' : typeof payload}`);
  }
  assertMemberSerializable(payload, '', 0, new Set());
}

/**
 * Validates the naming convention AND catalog membership.
 * Malformed (`no dot`, `Bad.Case`, two dots) → EVENT_NAME_MALFORMED;
 * well-formed but not one of the 27 catalog names (incl. wave-3 deferrals
 * like 'consent.granted') → EVENT_UNKNOWN.
 */
export function assertEventName(name: string): asserts name is EventName {
  if (typeof name !== 'string' || !EVENT_NAME_PATTERN.test(name)) {
    throw new DomainError(
      'EVENT_NAME_MALFORMED',
      `event name must be '<context>.<aggregate><PastTenseVerb>' in camelCase, got ${String(name)}`,
      { name: String(name) },
    );
  }
  if (!isEventName(name)) {
    throw new DomainError('EVENT_UNKNOWN', `unknown event name "${name}" — see docs/04-event-catalog.md (27 core events)`, {
      name,
    });
  }
}

/**
 * Validates a fully-formed envelope (used by `Outbox.append` as the gatekeeper
 * before an event reaches the wire, and directly testable).
 */
export function validateEnvelope(event: DomainEvent): void {
  const name: string = event.name;
  assertEventName(name);
  if (event.version !== EVENT_VERSIONS[name]) {
    throw new DomainError(
      'EVENT_VERSION_UNSUPPORTED',
      `event "${name}" is at schema version ${EVENT_VERSIONS[name]}, got ${String(event.version)}`,
      { name, expectedVersion: EVENT_VERSIONS[name], actualVersion: event.version },
    );
  }
  assertUuid(event.eventId, 'eventId');
  assertUuid(event.aggregateId, 'aggregateId');
  if (event.correlationId !== undefined) assertUuid(event.correlationId, 'correlationId');
  if (typeof event.occurredAt !== 'string') {
    // the envelope carries the ISO string on the wire; Dates normalize inside makeEnvelope
    throw new DomainError(
      'EVENT_OCCURRED_AT_INVALID',
      `envelope.occurredAt must be an ISO-8601 string, got ${typeof event.occurredAt} — build envelopes with makeEnvelope`,
      { occurredAt: String(event.occurredAt) },
    );
  }
  normalizeOccurredAt(event.occurredAt);
  assertSerializablePayload(event.payload);
}

/**
 * The only sanctioned way to build an event: validates the name against the
 * catalog, stamps the catalog version (1), normalizes occurredAt from the
 * caller's injected Clock, guards payload serializability, and freezes the
 * envelope (events are immutable facts).
 */
export function makeEnvelope<N extends EventName>(
  name: N,
  options: EnvelopeOptions,
  payload: PayloadOf<N>,
): DomainEvent<N, PayloadOf<N>> {
  assertEventName(name);
  assertSerializablePayload(payload);
  const envelope: DomainEvent<N, PayloadOf<N>> = {
    eventId: assertUuid(options.eventId, 'eventId'),
    name,
    version: EVENT_VERSIONS[name],
    occurredAt: normalizeOccurredAt(options.occurredAt),
    aggregateId: assertUuid(options.aggregateId, 'aggregateId'),
    ...(options.correlationId === undefined ? {} : { correlationId: assertUuid(options.correlationId, 'correlationId') }),
    payload,
  };
  return Object.freeze(envelope);
}

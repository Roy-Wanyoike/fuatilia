/**
 * Subscription grammar + pure matching (issue #47, SPEC §53).
 *
 * An endpoint subscribes to event types with either:
 *   - an EXACT catalog event name — `payment.confirmed`; or
 *   - a `prefix:*` WILDCARD over a known catalog context — `payment.*`.
 *
 * The prefix table is OPAQUE STRING DATA (docs/04 catalog + the wave-3..5
 * lane contexts): this lane never imports other lanes — events from other
 * lanes are referenced by name only. The prefix table is intentionally the
 * catalogue's context vocabulary so `unicorn.*` cannot silently subscribe to
 * nothing (WEBHOOK_EVENT_PREFIX_UNKNOWN).
 *
 * `matchesSubscription(pattern, eventType)` is total: anything it cannot
 * structurally match (malformed pattern or event type) matches NOTHING —
 * matching never throws.
 */
import { DomainError } from '../shared';

export const WEBHOOK_SUBSCRIPTION_MALFORMED = 'WEBHOOK_SUBSCRIPTION_MALFORMED';
export const WEBHOOK_EVENT_PREFIX_UNKNOWN = 'WEBHOOK_EVENT_PREFIX_UNKNOWN';

/**
 * Catalog context prefixes (docs/04 core events + wave-3..5 lane facts):
 * opaque strings, referenced by name only — never an import.
 */
export const KNOWN_EVENT_PREFIXES: readonly string[] = [
  'adjustment',
  'adjustments',
  'agent',
  'allocation',
  'behavior',
  'case',
  'collections',
  'comms',
  'consent',
  'dispute',
  'dunning',
  'fx',
  'intelligence',
  'invoicing',
  'ledger',
  'memory',
  'nba',
  'notifications',
  'payment',
  'paymentlink',
  'payments',
  'policy',
  'projections',
  'promise',
  'receivable',
  'receivables',
  'reconciliation',
  'segment',
];

/** The shape of a catalog event type: `<context>.<aggregate><PastTenseVerb>`. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$/;

export type SubscriptionMode = 'exact' | 'wildcard';

export interface EventSubscription {
  readonly pattern: string;
  readonly mode: SubscriptionMode;
  readonly addedAt: Date;
}

const PATTERN_SEGMENT = /^[a-z][a-zA-Z0-9]*$/;

const malformed = (detail: string): DomainError =>
  new DomainError(
    WEBHOOK_SUBSCRIPTION_MALFORMED,
    `subscription pattern must be an exact event type ('payment.confirmed') or a '<knownPrefix>.*' wildcard, ${detail}`,
  );

const unknownPrefix = (prefix: string): DomainError =>
  new DomainError(
    WEBHOOK_EVENT_PREFIX_UNKNOWN,
    `subscription prefix "${prefix}" is not a known event-type context (see docs/04-event-catalog.md)`,
    { prefix },
  );

/**
 * Parse + validate a subscription pattern. Throws WEBHOOK_SUBSCRIPTION_MALFORMED
 * for structural violations and WEBHOOK_EVENT_PREFIX_UNKNOWN when the prefix is
 * not a catalog context (a wildcard over an unknown context subscribes to
 * nothing — that is always a typo, so it is refused up front).
 */
export const parseSubscriptionPattern = (pattern: string): { readonly pattern: string; readonly mode: SubscriptionMode } => {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw malformed('got an empty pattern');
  }
  const segments = pattern.split('.');
  if (segments.length !== 2) {
    throw malformed(`got ${segments.length} dot-separated segment(s)`);
  }
  const prefix = segments[0] ?? '';
  const tail = segments[1] ?? '';
  if (!PATTERN_SEGMENT.test(prefix)) {
    throw malformed(`prefix "${prefix}" is not a lowerCamelCase context`);
  }
  if (tail === '*') {
    if (!KNOWN_EVENT_PREFIXES.includes(prefix)) throw unknownPrefix(prefix);
    return { pattern, mode: 'wildcard' };
  }
  if (!PATTERN_SEGMENT.test(tail)) {
    throw malformed(`tail "${tail}" is not a lowerCamelCase event name`);
  }
  if (!KNOWN_EVENT_PREFIXES.includes(prefix)) throw unknownPrefix(prefix);
  return { pattern, mode: 'exact' };
};

/**
 * The pure matcher: exact patterns compare for equality; a `prefix.*` wildcard
 * matches any well-formed event type whose context is exactly `prefix`
 * (whole-segment — `payment.*` never matches `payments.*` events). Malformed
 * input on either side matches nothing.
 */
export const matchesSubscription = (pattern: string, eventType: string): boolean => {
  if (typeof pattern !== 'string' || typeof eventType !== 'string') return false;
  if (!EVENT_TYPE_PATTERN.test(eventType)) return false;
  if (pattern.endsWith('.*')) {
    return pattern.slice(0, pattern.length - 2) === eventType.slice(0, eventType.indexOf('.'));
  }
  return pattern === eventType;
};

/**
 * defineEvent — the guard rail module authors run when wiring an event into a
 * producer. It validates the `<context>.<aggregate><PastTenseVerb>` camelCase
 * naming convention AND catalog membership (docs/04, 27 core events), plus the
 * payload schema version.
 *
 * Version policy: the catalog ships every event at version 1. Passing any other
 * version is refused with EVENT_VERSION_UNSUPPORTED — a version bump is a
 * deliberate catalog change (new envelope member / additive migration), never a
 * call-site argument.
 */
import { DomainError } from '../shared';
import { EVENT_VERSIONS } from './catalog';
import type { EventName } from './catalog';
import { assertEventName } from './envelope';

/** The validated definition of a catalog event. */
export interface EventDefinition {
  readonly name: EventName;
  readonly version: 1;
}

/**
 * Validate `name` + `version` against the catalog and return a frozen
 * definition descriptor.
 *
 * - malformed name (`noDot`, `Bad.Name`, `a.b.c`) → EVENT_NAME_MALFORMED
 * - well-formed but not in the 27-event catalog → EVENT_UNKNOWN
 * - version ≠ the catalog version for that name → EVENT_VERSION_UNSUPPORTED
 */
export function defineEvent(name: string, version: number): EventDefinition {
  assertEventName(name); // narrows to EventName or throws EVENT_NAME_MALFORMED / EVENT_UNKNOWN
  const catalogVersion = EVENT_VERSIONS[name];
  if (!Number.isSafeInteger(version) || version !== catalogVersion) {
    throw new DomainError(
      'EVENT_VERSION_UNSUPPORTED',
      `event "${name}" is at schema version ${catalogVersion}; got ${String(version)} — version bumps are catalog changes, not call-site arguments`,
      { name, expectedVersion: catalogVersion, actualVersion: version },
    );
  }
  return Object.freeze({ name, version: catalogVersion });
}

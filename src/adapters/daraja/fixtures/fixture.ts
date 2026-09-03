/**
 * Fixture row type + deep-freeze helper (issue #25, F15).
 *
 * Fixtures are TYPED FROZEN DATA: the payload carries the exact wire shape the
 * Daraja gateway sends, the registry carries the metadata the harness needs
 * (family, expectation, tampering marker). Every fixture is marked `synthetic`
 * — all values are invented Kenyan-realistic data (no real PII anywhere).
 */
import type { DarajaB2cPayload, DarajaC2bPayload, DarajaCallbackKind, DarajaStkPayload } from '../wire';

interface FixtureBase {
  /** Stable fixture id, namespaced per family, e.g. 'c2b.confirmation.paybill-single-invoice'. */
  readonly id: string;
  /** What the fixture models, for humans reviewing the suite. */
  readonly note: string;
}

export type DarajaFixture =
  | (FixtureBase & {
      readonly family: 'c2b-validation' | 'c2b-confirmation';
      readonly payload: DarajaC2bPayload;
      /** Marks a well-formed payload whose CONTENTS were tampered (same trans id, different money). */
      readonly tampered?: true;
      /** The stable code the DOMAIN must reject it with at intake. */
      readonly expectRejection?: string;
    })
  | (FixtureBase & {
      readonly family: 'stk-result';
      readonly payload: DarajaStkPayload;
    })
  | (FixtureBase & {
      readonly family: 'b2c-result';
      readonly payload: DarajaB2cPayload;
    })
  | (FixtureBase & {
      readonly family: 'malformed';
      /** Deliberately malformed / foreign wire data (typed `unknown` on purpose). */
      readonly payload: unknown;
      /** The stable DARAJA_* code the parser must reject it with (K1 boundary). */
      readonly expectRejection: string;
    });

/** The callback family a fixture delivers on the simulated transport. */
export const fixtureKind = (fixture: DarajaFixture): DarajaCallbackKind | 'malformed' => fixture.family;

/**
 * Deeply freeze a value in place and return it — fixtures are immutable facts,
 * so a misbehaving consumer cannot mutate the shared registry.
 */
export const deepFreeze = <T>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
    return Object.freeze(value);
  }
  return value;
};

/** Walks a value and reports whether EVERY nested object/array is frozen. */
export const isDeepFrozen = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return Object.isFrozen(value) && value.every(isDeepFrozen);
  }
  if (value !== null && typeof value === 'object') {
    return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(isDeepFrozen);
  }
  return true;
};

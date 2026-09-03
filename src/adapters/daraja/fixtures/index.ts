/**
 * Fixture registry (issue #25, F15).
 *
 * The registry is the stable, validated, deeply-frozen catalogue of Daraja
 * callback fixtures. Consumers (simulator, conformance harness, tests) resolve
 * deliveries by fixture id, so the catalogue is append-only by construction:
 * new fixture sets plug in through `createFixtureRegistry` without touching
 * the harness.
 *
 * Misuse carries stable codes: DARAJA_FIXTURE_NOT_FOUND,
 * DARAJA_FIXTURE_DUPLICATE_ID, DARAJA_FIXTURE_INVALID.
 */
import { DomainError } from '../../../domain/shared';
import { DARAJA_ERRORS } from '../codes';
import { deepFreeze, isDeepFrozen } from './fixture';
import type { DarajaFixture } from './fixture';
import { B2C_FIXTURES } from './b2c';
import { C2B_FIXTURES } from './c2b';
import { MALFORMED_FIXTURES } from './malformed';
import { STK_FIXTURES } from './stk';

export * from './fixture';
export { B2C_FIXTURES, C2B_FIXTURES, MALFORMED_FIXTURES, STK_FIXTURES };

/** Every built-in fixture, one flat list (frozen). */
export const DARAJA_FIXTURES: readonly DarajaFixture[] = deepFreeze([
  ...C2B_FIXTURES,
  ...STK_FIXTURES,
  ...B2C_FIXTURES,
  ...MALFORMED_FIXTURES,
]);

/** Structural validation: a fixture row must be internally consistent. */
const validateFixture = (fixture: DarajaFixture): void => {
  const fixtureId = typeof fixture.id === 'string' ? fixture.id : String(fixture.id);
  if (typeof fixture.id !== 'string' || fixture.id.trim() === '') {
    throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, 'fixture id is required');
  }
  if (typeof fixture.note !== 'string' || fixture.note.trim() === '') {
    throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} needs a note`);
  }
  if (fixture.payload === undefined || fixture.payload === null) {
    throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} needs a payload`);
  }
  const payload = fixture.payload as Record<string, unknown>;
  switch (fixture.family) {
    case 'c2b-validation':
    case 'c2b-confirmation':
      if (typeof payload['TransID'] !== 'string') {
        throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} must carry a C2B payload`);
      }
      if (fixture.tampered === true && typeof fixture.expectRejection !== 'string') {
        throw new DomainError(
          DARAJA_ERRORS.FIXTURE_INVALID,
          `tampered fixture ${fixtureId} must declare expectRejection`,
        );
      }
      break;
    case 'stk-result': {
      const body = payload['Body'] as Record<string, unknown> | undefined;
      if (typeof body?.['stkCallback'] !== 'object' || body['stkCallback'] === null) {
        throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} must carry an STK payload`);
      }
      break;
    }
    case 'b2c-result':
      if (typeof payload['ResultType'] !== 'number') {
        throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} must carry a B2C payload`);
      }
      break;
    case 'malformed':
      if (typeof fixture.expectRejection !== 'string' || fixture.expectRejection.trim() === '') {
        throw new DomainError(
          DARAJA_ERRORS.FIXTURE_INVALID,
          `malformed fixture ${fixtureId} must declare expectRejection`,
        );
      }
      break;
    default:
      throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, `fixture ${fixtureId} has an unknown family`);
  }
};

export interface DarajaFixtureRegistry {
  /** All fixtures, frozen, in registration order. */
  readonly all: readonly DarajaFixture[];
  /** Sorted fixture ids (stable for reports). */
  readonly ids: readonly string[];
  has(id: string): boolean;
  /** Resolve one fixture by id — DARAJA_FIXTURE_NOT_FOUND otherwise. */
  get(id: string): DarajaFixture;
  /** Fixtures of one family (registry-level convenience). */
  byFamily(family: DarajaFixture['family']): readonly DarajaFixture[];
}

/** Build a validated, deeply-frozen registry from fixture rows. */
export const createFixtureRegistry = (fixtures: readonly DarajaFixture[]): DarajaFixtureRegistry => {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new DomainError(DARAJA_ERRORS.FIXTURE_INVALID, 'a fixture registry needs at least one fixture');
  }
  const seen = new Map<string, DarajaFixture>();
  for (const fixture of fixtures) {
    validateFixture(fixture);
    if (seen.has(fixture.id)) {
      throw new DomainError(DARAJA_ERRORS.FIXTURE_DUPLICATE_ID, `fixture id ${fixture.id} registered twice`);
    }
    seen.set(fixture.id, fixture);
  }
  const all = deepFreeze([...fixtures]);
  const ids = all.map((f) => f.id).sort();
  const byId = new Map(all.map((f) => [f.id, f] as const));
  return deepFreeze({
    all,
    ids,
    has: (id: string): boolean => byId.has(id),
    get: (id: string): DarajaFixture => {
      const fixture = byId.get(id);
      if (fixture === undefined) {
        throw new DomainError(DARAJA_ERRORS.FIXTURE_NOT_FOUND, `no Daraja fixture registered as ${id}`);
      }
      return fixture;
    },
    byFamily: (family: DarajaFixture['family']): readonly DarajaFixture[] =>
      all.filter((f) => f.family === family),
  });
};

/** The default registry — every built-in fixture. */
export const DEFAULT_DARAJA_REGISTRY: DarajaFixtureRegistry = createFixtureRegistry(DARAJA_FIXTURES);

/** Resolve from the default registry (test/simulator convenience). */
export const getDarajaFixture = (id: string): DarajaFixture => DEFAULT_DARAJA_REGISTRY.get(id);

/** Registry invariant for tests: built-ins are deeply frozen. */
export const assertRegistryFrozen = (registry: DarajaFixtureRegistry): boolean => isDeepFrozen(registry);

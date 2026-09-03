/**
 * Fixture-registry conformance (issue #25, F15).
 *
 * Proves: every built-in fixture is typed-frozen wire data with unique ids;
 * every `malformed` row is rejected by the K1 parser with EXACTLY the stable
 * code it promises; well-formed rows parse cleanly; the registry refuses
 * misuse. Table-driven throughout — adding a fixture extends the tables.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import { DARAJA_ERRORS } from './codes';
import { DEFAULT_DARAJA_REGISTRY, createFixtureRegistry, type DarajaFixture } from './fixtures';
import { deepFreeze, isDeepFrozen } from './fixtures/fixture';
import { parseDarajaCallback } from './wire';

const registry = DEFAULT_DARAJA_REGISTRY;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

/** Parse options that let any well-formed row reach its family parser. */
const stkRequested = new Map(
  registry
    .byFamily('stk-result')
    .map((fixture) => {
      const body = (fixture.payload as { Body?: { stkCallback?: { CheckoutRequestID?: string } } }).Body;
      const checkoutRequestId = body?.stkCallback?.CheckoutRequestID ?? '';
      return [checkoutRequestId, { checkoutRequestId, requestedMinor: 250_000n }] as const;
    })
    .filter(([checkoutId]) => checkoutId !== ''),
);
const parseOptions = { c2bKind: 'c2b-confirmation', stkRequested } as const;

describe('the built-in fixture registry', () => {
  it('registers every family with unique, sorted ids', () => {
    expect(registry.ids.length).toBe(registry.all.length);
    expect([...registry.ids].sort()).toEqual([...registry.ids]);
    expect(registry.byFamily('c2b-validation').length).toBe(2);
    expect(registry.byFamily('c2b-confirmation').length).toBeGreaterThanOrEqual(5);
    expect(registry.byFamily('stk-result').length).toBe(6);
    expect(registry.byFamily('b2c-result').length).toBe(2);
    expect(registry.byFamily('malformed').length).toBeGreaterThanOrEqual(15);
  });

  it('deep-freezes every fixture — the registry cannot be mutated through a row', () => {
    for (const fixture of registry.all) {
      expect(isDeepFrozen(fixture), fixture.id).toBe(true);
    }
    expect(isDeepFrozen(registry)).toBe(true);
  });

  it('marks every fixture synthetic and documented', () => {
    for (const fixture of registry.all) {
      expect(fixture.id, fixture.id).toMatch(/^[a-z0-9.-]+$/);
      expect(fixture.note.length, fixture.id).toBeGreaterThan(10);
    }
  });

  it('resolves by id and refuses unknown ids (DARAJA_FIXTURE_NOT_FOUND)', () => {
    expect(registry.has('c2b.confirmation.paybill-single-invoice')).toBe(true);
    expect(registry.get('c2b.confirmation.paybill-single-invoice').family).toBe('c2b-confirmation');
    expect(registry.has('nope')).toBe(false);
    expectCode(() => registry.get('nope'), DARAJA_ERRORS.FIXTURE_NOT_FOUND);
  });

  it('refuses duplicate ids and empty registries', () => {
    const row = registry.all[0]!;
    expectCode(() => createFixtureRegistry([row, { ...row }]), DARAJA_ERRORS.FIXTURE_DUPLICATE_ID);
    expectCode(() => createFixtureRegistry([]), DARAJA_ERRORS.FIXTURE_INVALID);
  });

  it('refuses malformed fixture rows (table)', () => {
    const cases: readonly { readonly name: string; readonly row: unknown }[] = [
      { name: 'missing id', row: { family: 'malformed', payload: {}, expectRejection: 'X' } },
      { name: 'blank id', row: { id: '  ', family: 'malformed', payload: {}, expectRejection: 'X' } },
      { name: 'unknown family', row: { id: 'a.row', family: 'smoke-signal', payload: {} } },
      {
        name: 'malformed row without expectRejection',
        row: { id: 'a.row', family: 'malformed', payload: {} },
      },
      {
        name: 'non-malformed row with expectRejection',
        row: { id: 'a.row', family: 'stk-result', payload: {}, expectRejection: 'X' },
      },
    ];
    for (const c of cases) {
      expectCode(() => createFixtureRegistry([c.row as DarajaFixture]), DARAJA_ERRORS.FIXTURE_INVALID);
    }
  });
});

describe('the K1 boundary — malformed fixtures are rejected with their promised code', () => {
  // The malformed table runs WITHOUT initiation records: several rows promise
  // codes that fire only when the merchant has no record of the journey (the
  // no-amount row shares its checkout id with a well-formed fixture whose
  // world DOES carry the initiation).
  const malformedOptions = { c2bKind: 'c2b-confirmation' } as const;
  it('every malformed row parses to exactly its expectRejection code (table)', () => {
    const rows = registry.byFamily('malformed') as readonly (DarajaFixture & { readonly expectRejection: string })[];
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) {
      expect(row.expectRejection, row.id).toMatch(/^DARAJA_/);
      expectCode(() => parseDarajaCallback(row.payload, malformedOptions), row.expectRejection);
    }
  });

  it('the tampered-amount row is well-formed wire data (the domain rejects it, not the parser)', () => {
    const tampered = registry.get('c2b.confirmation.tampered-amount') as DarajaFixture & {
      readonly expectRejection: string;
    };
    expect(tampered.expectRejection).toBe('DUPLICATE_AMOUNT_MISMATCH'); // a DOMAIN code
    expect(() => parseDarajaCallback(tampered.payload, parseOptions)).not.toThrow();
  });

  it('every well-formed row parses cleanly with family-appropriate options', () => {
    for (const row of registry.all) {
      if (row.family === 'malformed') continue;
      const kind = row.family === 'stk-result' || row.family === 'b2c-result' ? undefined : 'c2b-confirmation';
      expect(
        () => parseDarajaCallback(row.payload, { c2bKind: kind, stkRequested }),
        row.id,
      ).not.toThrow();
    }
  });
});

describe('deepFreeze / isDeepFrozen helpers', () => {
  it('freezes nested structures and reports depth-freezing (table)', () => {
    const frozen = deepFreeze({ a: [1, { b: 'c' }], d: { e: { f: 1 } } });
    expect(isDeepFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen.a as unknown[]).push(2);
    }).toThrow();
    expect(isDeepFrozen('a string')).toBe(true);
    expect(isDeepFrozen(deepFreeze({ a: [{ b: [1] }] }))).toBe(true);
    expect(isDeepFrozen({ a: [{ b: [1] }] })).toBe(false); // outer not frozen
  });
});

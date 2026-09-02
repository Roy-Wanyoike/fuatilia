import { describe, expect, it } from 'vitest';
import { DomainError, type Clock } from '../shared';
import {
  checkCharacter,
  createNumberingService,
  formatInvoiceNumber,
  mod97Residue,
  validateInvoiceNumber,
} from './etims';

// --- fixtures ---------------------------------------------------------------

const YEAR_2026: Clock = { now: () => new Date('2026-06-15T10:00:00.000Z') };
const YEAR_1999: Clock = { now: () => new Date('1999-12-31T23:59:59.000Z') };

const seqSource =
  (from: number) =>
  (count: number): number[] =>
    Array.from({ length: count }, (_, i) => from + i);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- checksum primitive -------------------------------------------------------

describe('mod-97-style alphanumeric check character (documented scheme)', () => {
  it('computes the pinned known vectors', () => {
    // Hand-reduced residues: "KE202600000042" → 48 → 'C'.
    expect(mod97Residue('KE202600000042')).toBe(48);
    expect(checkCharacter('KE202600000042')).toBe('C');
    expect(checkCharacter('KE202600000001')).toBe('0');
    expect(checkCharacter('KE202600000100')).toBe('Y');
    expect(checkCharacter('KE199900000042')).toBe('F');
  });

  it('is deterministic and changes when the payload changes', () => {
    expect(checkCharacter('KE202600000042')).toBe(checkCharacter('KE202600000042'));
    const checks = new Set(
      Array.from({ length: 200 }, (_, i) => checkCharacter(`KE2026${String(i + 1).padStart(8, '0')}`)),
    );
    expect(checks.size).toBeGreaterThan(1); // the character actually carries information
  });
});

// --- format -------------------------------------------------------------------

describe('formatInvoiceNumber — K4 eTIMS shape KE<YYYY><seq8><check>', () => {
  it('formats with zero-padded sequence and trailing check character', () => {
    const number = formatInvoiceNumber(42, 2026);
    expect(number).toBe('KE202600000042C');
    expect(number).toMatch(/^KE\d{4}\d{8}[0-9A-Z]$/);
    expect(number).toHaveLength(15);
  });

  it('is deterministic per (sequence, year) and sensitive to both', () => {
    expect(formatInvoiceNumber(42, 2026)).toBe(formatInvoiceNumber(42, 2026));
    expect(formatInvoiceNumber(42, 2026)).not.toBe(formatInvoiceNumber(43, 2026));
    expect(formatInvoiceNumber(42, 2026)).not.toBe(formatInvoiceNumber(42, 2027));
    expect(formatInvoiceNumber(1, 2026)).toMatch(/^KE202600000001/);
  });

  it('rejects sequences outside the 8-digit field', () => {
    const table: Array<[number, string]> = [
      [0, 'ETIMS_SEQUENCE_INVALID'],
      [-5, 'ETIMS_SEQUENCE_INVALID'],
      [1.5, 'ETIMS_SEQUENCE_INVALID'],
      [100_000_000, 'ETIMS_SEQUENCE_INVALID'],
      [Number.NaN, 'ETIMS_SEQUENCE_INVALID'],
    ];
    for (const [seq, code] of table) {
      expectCode(() => formatInvoiceNumber(seq, 2026), code);
    }
  });
});

// --- numbering service ---------------------------------------------------------

describe('createNumberingService — injectable sequence source (K4, I/O outside)', () => {
  it('reserves a single number from the injected sequence and clock year', () => {
    const service = createNumberingService(seqSource(1), YEAR_2026);
    const numbers = service.reserveInvoiceNumbers(1);
    expect(numbers).toEqual([`KE202600000001${checkCharacter('KE202600000001')}`]);
  });

  it('takes the issuance year from the injected Clock (UTC)', () => {
    const service = createNumberingService(seqSource(7), YEAR_1999);
    expect(service.reserveInvoiceNumbers(2)).toEqual([
      `KE199900000007${checkCharacter('KE199900000007')}`,
      `KE199900000008${checkCharacter('KE199900000008')}`,
    ]);
  });

  it('keeps every number unique across a 100-reservation burst', () => {
    const service = createNumberingService(seqSource(1), YEAR_2026);
    const numbers = service.reserveInvoiceNumbers(100);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);
    // Every number in the burst also re-validates through the parser.
    for (const raw of numbers) {
      const parsed = validateInvoiceNumber(raw);
      expect(parsed.valid).toBe(true);
    }
  });

  it('keeps numbers unique across consecutive bursts (no reuse between calls)', () => {
    const first = createNumberingService(seqSource(1), YEAR_2026).reserveInvoiceNumbers(100);
    const second = createNumberingService(seqSource(101), YEAR_2026).reserveInvoiceNumbers(100);
    expect(new Set([...first, ...second]).size).toBe(200);
  });

  it('validates the reservation request and the sequence source', () => {
    const service = createNumberingService(seqSource(1), YEAR_2026);

    // count must be a positive integer
    for (const count of [0, -3, 2.5, Number.NaN]) {
      expectCode(() => service.reserveInvoiceNumbers(count), 'ETIMS_COUNT_INVALID');
    }
    // sequence source must deliver exactly `count` numbers
    const fixedSource = createNumberingService(() => [1, 2, 3], YEAR_2026);
    expectCode(() => fixedSource.reserveInvoiceNumbers(5), 'ETIMS_SEQUENCE_SOURCE_MISMATCH'); // too few
    expectCode(() => fixedSource.reserveInvoiceNumbers(2), 'ETIMS_SEQUENCE_SOURCE_MISMATCH'); // too many
    const overSource = createNumberingService((n) => seqSource(1)(n + 2), YEAR_2026);
    expectCode(() => overSource.reserveInvoiceNumbers(3), 'ETIMS_SEQUENCE_SOURCE_MISMATCH');
    // sequences must be valid and distinct
    const dupSource = createNumberingService(() => [4, 4], YEAR_2026);
    expectCode(() => dupSource.reserveInvoiceNumbers(2), 'ETIMS_SEQUENCE_DUPLICATE');
    const badSource = createNumberingService(() => [0, 9], YEAR_2026);
    expectCode(() => badSource.reserveInvoiceNumbers(2), 'ETIMS_SEQUENCE_INVALID');
    // broken clock
    const brokenClock = createNumberingService(seqSource(1), { now: () => new Date('never') });
    expectCode(() => brokenClock.reserveInvoiceNumbers(1), 'ETIMS_CLOCK_INVALID');
  });
});

// --- parser ---------------------------------------------------------------------

describe('validateInvoiceNumber — parser round-trip and refusal table', () => {
  it('round-trips every formatted number back to its parts', () => {
    const table: Array<[number, number]> = [
      [1, 2026],
      [42, 2026],
      [12345678, 2025],
      [99999999, 1999],
      [7, 2031],
    ];
    for (const [sequence, year] of table) {
      const raw = formatInvoiceNumber(sequence, year);
      const parsed = validateInvoiceNumber(raw);
      expect(parsed.valid, raw).toBe(true);
      if (parsed.valid) {
        expect(parsed.country, raw).toBe('KE');
        expect(parsed.year, raw).toBe(year);
        expect(parsed.sequence, raw).toBe(sequence);
        expect(parsed.checkChar, raw).toBe(raw.slice(-1));
      }
    }
  });

  it('rejects a tampered check character', () => {
    const raw = formatInvoiceNumber(42, 2026); // KE202600000042C
    const tampered = raw.slice(0, -1) + (raw.endsWith('C') ? 'D' : 'C');
    const parsed = validateInvoiceNumber(tampered);
    expect(parsed).toEqual({ valid: false, reason: 'CHECKSUM_MISMATCH' });
  });

  it('rejects malformed shapes without throwing', () => {
    const table = [
      '',
      'KE',
      'KE2026',
      'KE202600000042', // missing check character
      'KE202600000042CX', // trailing junk
      'ke202600000042c', // lowercase (eTIMS numbers are upper-case)
      'UG202600000042C', // wrong country
      'KE202642C', // sequence not zero-padded
      'KE202A00000042C', // letter inside the sequence field
      'KE20-60000004 2C', // stray separators
      'KE20260000004 2C', // internal space
    ];
    for (const raw of table) {
      expect(validateInvoiceNumber(raw)).toEqual({ valid: false, reason: 'MALFORMED' });
    }
  });

  it('treats a digit check character as valid when it matches', () => {
    // KE2026000000010 — check character '0' (see known vector above).
    const parsed = validateInvoiceNumber('KE2026000000010');
    expect(parsed).toEqual({
      valid: true,
      country: 'KE',
      year: 2026,
      sequence: 1,
      checkChar: '0',
    });
  });
});

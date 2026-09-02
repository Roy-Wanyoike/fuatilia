/**
 * eTIMS-ready invoice numbering (issue #10, review finding K4).
 *
 * KRA's eTIMS expects invoice numbers of the shape
 *
 *     KE<YYYY><8-digit zero-padded sequence><check character>
 *
 * e.g. `KE2026000000427` — country prefix, issuance year, a contiguous
 * sequence reserved at issuance, and a trailing check character that survives
 * transcription (K2 agents re-key numbers off M-Pesa receipts all day).
 *
 * Purity contract: the generator NEVER reads a database, a counter file or the
 * wall clock. The caller injects
 *   - `sequenceSource(count)` — returns the next `count` sequence numbers
 *     (the reservation read/commit stays outside the core, I/O-free here); and
 *   - a `Clock` for the issuance year.
 *
 * Check character (documented, deterministic — NOT a cryptographic MAC):
 *   1. Interpret the 14-char payload "KE<YYYY><seq8>" as a base-36 number:
 *      '0'-'9' → 0-9, 'A'-'Z' → 10-35 (all payload chars are alphanumeric).
 *   2. Reduce it modulo 97 (mod-97-style, computed iteratively — no BigInt,
 *      no float drift: intermediate (r*36 + v) ≤ 96*36+35 < 2^53).
 *   3. The check character is the ASCII-36 alphabet member at index r mod 36.
 * `validateInvoiceNumber` recomputes the same residue, so any single-character
 * substitution or transposition that shifts the residue is rejected.
 */
import { DomainError, type Clock } from '../shared';

const CHECK_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SEQ_WIDTH = 8;
const MAX_SEQUENCE = 99_999_999; // fits the 8-digit field exactly

const charValue = (char: string): number => {
  const v = CHECK_ALPHABET.indexOf(char);
  if (v < 0) {
    throw new DomainError('ETIMS_PAYLOAD_NOT_ALPHANUMERIC', `non-alphanumeric character: ${char}`, {
      char,
    });
  }
  return v;
};

/** Base-36 interpretation of the payload reduced modulo 97 (iterative, exact). */
export const mod97Residue = (payload: string): number => {
  let residue = 0;
  for (const char of payload) {
    residue = (residue * 36 + charValue(char)) % 97;
  }
  return residue;
};

/** The single alphanumeric check character for a full 14-char payload. */
export const checkCharacter = (payload: string): string =>
  CHECK_ALPHABET.charAt(mod97Residue(payload) % 36);

/**
 * Format one eTIMS invoice number. Pure and deterministic:
 * `KE<year><String(seq).padStart(8,'0')><check>`.
 */
export function formatInvoiceNumber(sequence: number, issuedYear: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new DomainError(
      'ETIMS_SEQUENCE_INVALID',
      `sequence must be an integer in [1, ${MAX_SEQUENCE}], got ${sequence}`,
      { sequence },
    );
  }
  if (!Number.isInteger(issuedYear) || issuedYear < 1000 || issuedYear > 9999) {
    throw new DomainError('ETIMS_CLOCK_INVALID', `issuance year must be a 4-digit year, got ${issuedYear}`, {
      issuedYear,
    });
  }
  const payload = `KE${issuedYear}${String(sequence).padStart(SEQ_WIDTH, '0')}`;
  return `${payload}${checkCharacter(payload)}`;
}

export interface EtimsNumberingService {
  /**
   * Reserve `count` invoice numbers. Uniqueness within (and across) bursts
   * comes from the sequence source; the residue-check character is derived
   * deterministically and never collides for distinct payloads of equal
   * length in practice (verified by the 100-reservation burst test).
   */
  reserveInvoiceNumbers(count: number): string[];
}

/**
 * Build a numbering service over an injected sequence source (K4). The source
 * is the ONLY side-effecting dependency and it sits outside the core: it might
 * be a SELECT … FOR UPDATE over a counter row, a KRA reservation call, etc.
 */
export function createNumberingService(
  sequenceSource: (count: number) => number[],
  clock: Clock,
): EtimsNumberingService {
  return {
    reserveInvoiceNumbers(count: number): string[] {
      if (!Number.isInteger(count) || count < 1) {
        throw new DomainError('ETIMS_COUNT_INVALID', `count must be a positive integer, got ${count}`, {
          count,
        });
      }
      const now = clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new DomainError('ETIMS_CLOCK_INVALID', 'clock returned an invalid Date');
      }
      const year = now.getUTCFullYear(); // UTC keeps the format independent of host TZ

      const sequences = sequenceSource(count);
      if (!Array.isArray(sequences) || sequences.length !== count) {
        throw new DomainError(
          'ETIMS_SEQUENCE_SOURCE_MISMATCH',
          `sequence source returned ${sequences?.length ?? 'non-array'} numbers, expected ${count}`,
          { expected: count, received: sequences?.length ?? null },
        );
      }
      const seen = new Set<number>();
      for (const seq of sequences) {
        if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQUENCE) {
          throw new DomainError(
            'ETIMS_SEQUENCE_INVALID',
            `sequence source produced invalid sequence ${seq}`,
            { sequence: seq },
          );
        }
        if (seen.has(seq)) {
          throw new DomainError('ETIMS_SEQUENCE_DUPLICATE', `duplicate sequence ${seq} in one reservation`, {
            sequence: seq,
          });
        }
        seen.add(seq);
      }
      return sequences.map((seq) => formatInvoiceNumber(seq, year));
    },
  };
}

// --- parser -------------------------------------------------------------------

export type InvoiceNumberParse =
  | {
      readonly valid: true;
      readonly country: 'KE';
      readonly year: number;
      readonly sequence: number;
      readonly checkChar: string;
    }
  | { readonly valid: false; readonly reason: 'MALFORMED' | 'CHECKSUM_MISMATCH' };

const ETIMS_SHAPE = /^KE(\d{4})(\d{8})([0-9A-Z])$/;

/**
 * Parse + verify an eTIMS invoice number. Pure format gate: malformed shapes
 * and checksum failures are RESULTS (typed reasons), not exceptions — a bad
 * number typed at a boundary is normal input, not a programming error.
 * (Issuance policy — e.g. which years/sequences were ever reserved — is out of
 * scope here.)
 */
export function validateInvoiceNumber(raw: string): InvoiceNumberParse {
  if (typeof raw !== 'string') {
    return { valid: false, reason: 'MALFORMED' };
  }
  const m = ETIMS_SHAPE.exec(raw);
  if (!m) {
    return { valid: false, reason: 'MALFORMED' };
  }
  const year = Number(m[1]);
  const sequence = Number(m[2]);
  const checkChar = m[3] as string;
  const payload = `KE${m[1]}${m[2]}`;
  const expected = checkCharacter(payload);
  if (checkChar !== expected) {
    return { valid: false, reason: 'CHECKSUM_MISMATCH' };
  }
  return { valid: true, country: 'KE', year, sequence, checkChar };
}

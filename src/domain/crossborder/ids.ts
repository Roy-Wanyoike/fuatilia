/**
 * Cross-border lane id helpers (mirrors payments/ids.ts — lanes never import
 * lanes).
 *
 * The domain core is pure: no I/O, no RNG, no Date.now(). Ids are therefore
 * either supplied by the caller (preferred — adapters mint UUIDs) or derived
 * deterministically from a seed string, so replaying the same logical command
 * yields the same id (a bonus for idempotent replay).
 */
import { uuid } from '../shared';
import type { Uuid } from '../shared';

const FNV_OFFSET = 0x811c9dc5n;
const FNV_PRIME = 0x01000193n;
const WORD_MASK = 0xffffffffn;

const fnv1a32 = (round: number, input: string): bigint => {
  let hash = FNV_OFFSET ^ BigInt(round);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & WORD_MASK;
  }
  return hash;
};

/** Deterministic UUID-shaped id (8-4-4-4-12 hex) derived from a seed. Pure. */
export const uuidFromSeed = (seed: string): Uuid => {
  const w = (round: number): string => fnv1a32(round, seed).toString(16).padStart(8, '0');
  const raw = `${w(0)}-${w(1).slice(0, 4)}-${w(1).slice(4, 8)}-${w(2).slice(0, 4)}-${w(2).slice(4, 8)}${w(3)}`;
  return uuid(raw);
};

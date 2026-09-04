import { z } from 'zod';
import type { ErrorCode } from './error-codes';
import { KNOWN_ERROR_CODES } from './error-codes';

/**
 * Envelope + primitive wire schemas, hand-derived from
 * api/openapi/fuatilia.v1.yaml (components.schemas). Successes are
 * `{ data, meta? }`; failures are `{ error: { code, message }, requestId }`.
 *
 * Schemas are STRICT on purpose: the contract is frozen (v1.0.0), so an
 * unexpected field on the wire is contract drift and must surface as a
 * tagged decoding refusal instead of silently passing through.
 */

export const CURRENCIES = ['KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** components.schemas.Money — integer MINOR units; floats banned (R10). */
export const moneySchema = z
  .object({
    minor: z.number().int().nonnegative(),
    currency: z.enum(CURRENCIES),
  })
  .strict();
export type Money = z.infer<typeof moneySchema>;

/** components.schemas.PositiveMoney — request-side, strictly positive. */
export const positiveMoneySchema = z
  .object({
    minor: z.number().int().positive(),
    currency: z.enum(CURRENCIES),
  })
  .strict();
export type PositiveMoney = z.infer<typeof positiveMoneySchema>;

/** components.schemas.PaginationMeta — `meta` on paginated lists. */
export const paginationMetaSchema = z
  .object({
    pagination: z
      .object({
        nextCursor: z.string().nullable(),
        total: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/**
 * Raw error envelope (components.schemas.ErrorResponse). `code` is checked
 * against the wire PATTERN only at this stage — membership in the known-code
 * union happens in the client so that unknown codes become a TAGGED refusal
 * (`unknown-error`) instead of a zod failure. Both are non-throwing.
 */
export const rawErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string(),
      })
      .strict(),
    requestId: z.string(),
  })
  .strict();
export type RawErrorEnvelope = z.infer<typeof rawErrorEnvelopeSchema>;

/** Error envelope whose code is a KNOWN union member. */
export const knownErrorEnvelopeSchema = rawErrorEnvelopeSchema.extend({
  error: z.object({
    code: z.enum(KNOWN_ERROR_CODES),
    message: z.string(),
  }),
});
export type KnownErrorEnvelope = {
  error: { code: ErrorCode; message: string };
  requestId: string;
};

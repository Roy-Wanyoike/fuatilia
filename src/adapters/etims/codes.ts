/**
 * Stable error codes for the eTIMS adapter lane (issue #129).
 *
 * Every failure this lane raises carries a machine-readable, stable
 * SCREAMING_SNAKE code, so the transport layer can map it to API responses,
 * retry decisions and dead-letter queues without string matching.
 *
 * Families:
 *  - ETIMS_CONFIG_*        — configuration misuse (env-injected, never literal)
 *  - ETIMS_COUNT_*         — caller misuse of the reservation port
 *  - ETIMS_CHECKPOINT_*    — untrusted LOCAL state (the persisted checkpoint)
 *  - ETIMS_STOCK / ROLLOVER / AUDIT — numbering-source refusals (fail-closed;
 *    a refused reservation never invents or reuses a sequence)
 *  - ETIMS_VSDC_*          — the KRA VSDC boundary: transport failures,
 *    the K1 untrusted-response gate, and KRA business refusals
 *
 * Codes whose meaning is shared with the pure domain port
 * (`src/domain/consent/etims.ts`) deliberately reuse the domain's exact
 * strings (`ETIMS_CLOCK_INVALID`, `ETIMS_COUNT_INVALID`) so callers see one
 * coherent failure vocabulary across both layers.
 */
export const ETIMS_ERRORS = {
  /** Env configuration is missing, malformed or self-inconsistent. */
  CONFIG_INVALID: 'ETIMS_CONFIG_INVALID',
  /** The injected clock returned a non-Date / NaN (domain contract code). */
  CLOCK_INVALID: 'ETIMS_CLOCK_INVALID',
  /** Reservation count is not a positive integer (domain contract code). */
  COUNT_INVALID: 'ETIMS_COUNT_INVALID',
  /** Burst exceeds the configured maximum reservation. */
  COUNT_TOO_LARGE: 'ETIMS_COUNT_TOO_LARGE',
  /** The persisted local checkpoint failed structural validation (fail-closed). */
  CHECKPOINT_INVALID: 'ETIMS_CHECKPOINT_INVALID',
  /** No pre-granted stock for the request; a refill intent was queued. */
  STOCK_EXHAUSTED: 'ETIMS_STOCK_EXHAUSTED',
  /** Clock year moved past the active band's year; remaining stock burned. */
  YEAR_ROLLOVER: 'ETIMS_YEAR_ROLLOVER',
  /** The audit trail refused the entry — the reservation is burned, never handed out. */
  AUDIT_WRITE_FAILED: 'ETIMS_AUDIT_WRITE_FAILED',
  /** The VSDC call could not be completed (network layer threw) — retryable. */
  VSDC_NETWORK_ERROR: 'ETIMS_VSDC_NETWORK_ERROR',
  /** KRA gateway answered 5xx — retryable. */
  VSDC_PROVIDER_OUTAGE: 'ETIMS_VSDC_PROVIDER_OUTAGE',
  /** KRA gateway answered 429 — retryable. */
  VSDC_RATE_LIMITED: 'ETIMS_VSDC_RATE_LIMITED',
  /** KRA gateway rejected the credential (401/403) — permanent. */
  VSDC_AUTH_REJECTED: 'ETIMS_VSDC_AUTH_REJECTED',
  /** The response failed the K1 untrusted-input gate — permanent. */
  VSDC_WIRE_MALFORMED: 'ETIMS_VSDC_WIRE_MALFORMED',
  /** The granted band does not cover the requested count — permanent. */
  VSDC_BAND_SIZE_MISMATCH: 'ETIMS_VSDC_BAND_SIZE_MISMATCH',
  /** The granted band breaks gapless contiguity — permanent, never activated. */
  VSDC_BAND_NONCONTIGUOUS: 'ETIMS_VSDC_BAND_NONCONTIGUOUS',
} as const;

export type EtimsErrorCode = (typeof ETIMS_ERRORS)[keyof typeof ETIMS_ERRORS];

/**
 * KRA business refusals carry their wire `resultCd` in a derived but STABLE
 * code, `ETIMS_VSDC_REFUSED_<resultCd>` (one code per KRA result code, e.g.
 * `ETIMS_VSDC_REFUSED_013`). The resultCd is a validated `\d{3,4}` string, so
 * the derived code can never smuggle arbitrary wire text.
 */
export const refusedResultCode = (resultCd: string): string => `ETIMS_VSDC_REFUSED_${resultCd}`;

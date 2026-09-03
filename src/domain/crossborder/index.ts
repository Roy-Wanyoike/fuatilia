/**
 * Cross-border payments domain lane (issue #48, SPEC §33 deferral).
 *
 * Corridors, FX quotes with expiry, transfer intents and fee schedules as
 * pure domain facts. The movement itself stays with the payment products;
 * Fuatilia understands and tracks. NO fund-truth writes: this lane never
 * allocates or settles receivables — it produces facts the payments and
 * ledger lanes may consume later via events.
 *
 * Imports: `../shared` + own files ONLY. Cross-lane ids are opaque Uuids.
 * Time is the injected Clock; no I/O, no RNG, no Date.now().
 */
export * from './corridor';
export * from './events';
export * from './fees';
export * from './ids';
export * from './intent';
export * from './quote';

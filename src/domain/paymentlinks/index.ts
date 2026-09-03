/**
 * Payment links lane (wave 3, issue #21, SPEC §28) — secure single/partial-use
 * collection links with a full lifecycle and idempotent redemption.
 * Contract: src/domain/paymentlinks/README.md. Imports ONLY from '../shared';
 * receivables and payments are referenced by opaque Uuid ids, and the payments
 * lane consumes redemptions through the `paymentlink.redeemed` intent payload.
 */
export * from './link';
export * from './events';
export * from './redeem';

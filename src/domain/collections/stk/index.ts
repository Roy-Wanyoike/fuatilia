/**
 * Collections / STK-push execution lane (RICE #2 — "M-Pesa STK-push as a
 * policy-gated collections execution action").
 *
 * "Collect now via STK push": the rail-native collections move, composed
 * from the EXISTING pure cores —
 *
 *   NBA economics → proposeStkPush → gateStkPush (DPA consent + policy
 *   engine) → (approveStkPush) → initiateStkPush (injected `StkPushWire`
 *   port — the Go Daraja client ships the adapter) → reconcileStkCallback
 *   (through the existing payments intake core, R9 idempotent) →
 *   expireStkPushIfDue (the stuck path). Every transition emits its lane
 *   event plus the existing cross-lane audit facts it triggers.
 *
 * Contract: src/domain/collections/stk/README.md. Imports existing lanes
 * (shared, ussd normalization, consent guard, policy engine, payments
 * intake, audit projection) — this lane is the EXECUTION composition point;
 * nothing here invents money, and fund truth is only ever written by the
 * existing intake/match core.
 */
export * from './events';
export * from './wire';
export * from './actions';
export * from './gate';
export * from './audit';

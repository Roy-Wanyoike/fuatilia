/**
 * Clock port — mirrors the backend's injected-clock house rule:
 * production code composes `systemClock`; tests inject deterministic
 * clocks (no real Date.now() under test).
 */
export type Clock = () => Date;

export function systemClock(): Date {
  return new Date();
}

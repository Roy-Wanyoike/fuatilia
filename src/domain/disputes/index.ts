/**
 * Disputes lane (wave 3, issue #20, SPEC §29) — dispute lifecycle + the
 * collections pause policy.
 * Contract: src/domain/disputes/README.md. Imports ONLY from '../shared';
 * other modules (receivable, credit note, write-off, user) are referenced by
 * opaque Uuid ids, and collections lanes consume the pause policy as plain
 * data from ./pause.
 */
export * from './dispute';
export * from './events';
export * from './pause';

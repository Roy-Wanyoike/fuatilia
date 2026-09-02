/**
 * Receivables lane (wave 1, issue #1) — the legal debt position.
 * Contract: src/domain/receivables/README.md. Imports ONLY from '../shared';
 * other modules are referenced by opaque Uuid ids.
 */
export * from './aging';
export * from './events';
export * from './invoice';
export * from './receivable';

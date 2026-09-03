/**
 * Intelligence lane (wave 4, issue #23, review finding H7) — collections
 * priority scoring, the next-capability recommendation matrix and the
 * append-only recommendation feedback loop.
 * Contract: src/domain/intelligence/README.md. Imports ONLY from '../shared'
 * + own files; other modules (receivables, promises, disputes, consent,
 * collections) are referenced through opaque Uuid ids and plain-data
 * projections — never imported. Strictly read-only over fund truth.
 */
export * from './events';
export * from './feedback';
export * from './recommendations';
export * from './scoring';

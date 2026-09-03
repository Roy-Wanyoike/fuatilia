/**
 * Collections lane (wave 3, issue #8) — CollectionsCase lifecycle, the
 * append-only dunning action log, the R8 case-exclusivity invariant and the
 * K2 dunning-consent hook.
 * Contract: src/domain/collections/README.md. Imports ONLY from '../shared'
 * + own files; other modules interact through these pure functions and
 * opaque Uuid ids (receivables, promises, disputes, consent).
 */
export * from './actions';
export * from './case';
export * from './derive';
export * from './events';

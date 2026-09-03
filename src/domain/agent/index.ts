/**
 * Agent capability lane (wave 5, issue #35) — capability queries, not CRUD:
 * financial state, receivable priorities and collections recommendations,
 * answered WITH EVIDENCE over plain-data facts.
 * Contract: src/domain/agent/README.md. Imports ONLY from '../shared'
 * + own files; other modules are referenced through opaque Uuid ids. Pure,
 * read-only, no fund-truth writes — ever.
 */
export * from './events';
export * from './facts';
export * from './financial-state';
export * from './priorities';
export * from './recommendations';

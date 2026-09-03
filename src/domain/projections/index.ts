/**
 * Projections lane (wave 4, issue #24) — segment strategies + reporting
 * projections (SPEC §19/§20/§66).
 * Contract: src/domain/projections/README.md. Imports ONLY from '../shared'
 * + own files; other modules interact through these pure, read-only
 * functions, plain-data facts and opaque Uuid ids. NO fund-truth writes,
 * ever: every forward-looking number is a labeled projection.
 */
export * from './facts';
export * from './aging';
export * from './effectiveness';
export * from './projection';
export * from './segments';
export * from './strategies';
export * from './events';

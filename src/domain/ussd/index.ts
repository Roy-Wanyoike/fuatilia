/**
 * USSD lane (wave 7, issue #54) — SPEC §31 low-tech session workflows:
 * the menu graph as pure configuration, the session state machine, and the
 * five customer flows over injected read-only capability ports. Contract:
 * src/domain/ussd/README.md. Imports ONLY from '../shared' + own files;
 * other modules interact through these pure functions, frozen graph data
 * and opaque Uuid ids. Channel transport is an adapter concern.
 */
export * from './events';
export * from './flows';
export * from './menu';
export * from './session';

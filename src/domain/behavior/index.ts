/**
 * Behavior lane (wave 4, issue #26, SPEC §4 + §24) — customer behavior
 * profiles, drift trajectories and explainable anomaly detection.
 * Contract: src/domain/behavior/README.md. Imports ONLY from '../shared' and
 * own files; every other lane (payments, promises, disputes, communications,
 * allocation) is referenced by opaque Uuid ids and enters as PLAIN-DATA
 * fact histories the caller projects from event streams.
 */
export * from './profile';
export * from './drift';
export * from './anomaly';
export * from './events';

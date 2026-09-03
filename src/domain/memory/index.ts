/**
 * Memory lane (wave 5, issue #37, VISION §3.3/§3.7) — the explainable customer
 * financial memory: event-derived facts → behavioral features → claims with
 * evidence.
 * Contract: src/domain/memory/README.md. Imports ONLY from '../shared' and own
 * files; every cross-lane reference is an opaque Uuid id. This lane is a pure
 * FEATURE SUPPLIER for F21 (financial-state) and F22 (NBA features): plain
 * data in, plain claims out, no fund-truth writes, no coupling downstream.
 */
export * from './facts';
export * from './claims';
export * from './snapshot';
export * from './events';
export * from './diff';

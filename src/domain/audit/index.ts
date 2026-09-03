/**
 * Unified append-only audit trail (issue #53, SPEC §37).
 *
 * House rule: this lane imports ONLY `../shared` + its own files.
 * Cross-lane references (orgs, principals, entities, approvals) are opaque
 * `Uuid`/string handles — never imported types.
 */
export * from './redact';
export * from './record';
export * from './events';
export * from './chain';
export * from './project';

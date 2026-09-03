/**
 * Auth & RBAC domain lane (issue #46, SPEC §34/§35/§37).
 *
 * House rule: this lane imports ONLY `../shared` + its own files.
 * Cross-lane references (org, user, resource ids) are opaque `Uuid`s —
 * never imported types.
 */
export * from './events';
export * from './user';
export * from './roles';
export * from './assignments';
export * from './apikeys';
export * from './sessions';
export * from './guard';

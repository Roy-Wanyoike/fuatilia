/**
 * Policy lane (wave 5, issue #34, VISION §3.9) — deterministic action
 * governance: the safety layer between AI (and any automation) and financial
 * execution. AI never decides what it is allowed to do.
 * Contract: src/domain/policy/README.md. Imports ONLY from '../shared' and
 * own files; every other lane (consent, disputes, promises, collections,
 * receivables) is referenced by opaque Uuid ids and enters as PLAIN-DATA
 * facts the caller projects (consentPresent, disputeOpen, promisePending).
 * Explicitly out of scope: executing anything, consent-registry access,
 * auth/RBAC — an `allow` here is permission, not execution.
 */
export * from './request';
export * from './rules';
export * from './engine';
export * from './events';

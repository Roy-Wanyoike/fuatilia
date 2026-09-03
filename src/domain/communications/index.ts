/**
 * Communications lane (wave 3, issue #22) — SPEC §26 Unified Collections
 * Inbox domain: conversations, messages, delivery attempts, versioned
 * templates, pure provider ports and the K2 consent-before-send boundary.
 * Contract: src/domain/communications/README.md. Imports ONLY from
 * '../shared' + own files; other modules interact through these pure
 * functions and opaque Uuid ids.
 */
export * from './conversation';
export * from './events';
export * from './guard';
export * from './provider';
export * from './templates';

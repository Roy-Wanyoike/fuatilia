/**
 * Consent lane (wave 2, issue #10) — DPA 2019 consent registry, WhatsApp
 * opt-in gate (K2/K3) and eTIMS numbering hooks (K4).
 * Contract: src/domain/consent/README.md. Imports ONLY from '../shared';
 * other modules interact through these pure functions and opaque Uuid ids.
 */
export * from './consent-grant';
export * from './dsar';
export * from './etims';
export * from './guard';

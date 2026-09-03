/**
 * Approvals lane (wave 7, issue #52, SPEC §36) — maker-checker approval
 * workflows for sensitive financial operations: org-configurable approval
 * policies (per operation type, optional amount threshold, required checker
 * roles, DISTINCT-approver quorum, TTL) and the ApprovalRequest aggregate
 * that resolves them (drafted → pending → approved | rejected | expired |
 * cancelled; approved → applied). Self-approval is refused; every refusal is
 * a VALUE carrying a stable APPROVAL_* code AND an approvals.decisionRefused
 * event; the lane returns the approval evidence bundle but NEVER executes
 * the operation — no fund-truth writes.
 * Contract: src/domain/approvals/README.md. Imports ONLY from '../shared'
 * and own files; every other lane (auth roles, receivables, payments,
 * ledger) is referenced by opaque Uuid ids / opaque actor ids.
 */
export * from './policy';
export * from './request';
export * from './events';

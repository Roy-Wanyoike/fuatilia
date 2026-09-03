# Approvals lane — wave 7 (issue #52, SPEC §36)

Owns **maker-checker approval workflows** — the four-eyes gate between a
maker's sensitive financial operation and its execution:

```text
maker → sensitive operation → APPROVALS LANE → pending request
                                     ↓
                    checker panel (quorum, distinct approvers, roles)
                                     ↓
                     approved → evidence bundle → executor applies
```

**The lane never executes the operation.** `markApplied` returns the approval
EVIDENCE BUNDLE (who approved, under which policy, when, with which quorum) —
the calling lane attaches it to the executed operation and the audit trail.
No fund-truth writes, ever (R1/R2 stay with the ledger). Refusals are
first-class VALUES + `approvals.decisionRefused` events, never silent — the
same refusal-as-value discipline as the policy lane's `require_approval`,
which this lane is the workflow resolution OF (cross-lane = opaque ids +
plain data; the policy lane is never imported).

## Scope

- **`policy.ts`** — org-configurable approval policies and the deterministic
  requirement check:
  - `OPERATION_TYPES` — closed vocabulary `refund | write_off | credit_note |
    bank_destination_change | manual_adjustment` (the §36 examples);
  - `ApprovalPolicy` — threshold (`amountMinor` + `Currency`, `null` =
    catch-all for the operation type), `requiredApproverRoles` (≥ 1),
    `quorum` (distinct approvers, default `DEFAULT_QUORUM = 1`, never above
    the role count), `ttlDays` (request expiry);
  - `assertApprovalPolicy` / `assertPolicySet` — a typo'd policy is a
    SECURITY bug: malformed single policies and set-level ambiguities
    (duplicate ids, two catch-alls per type, two identical thresholds, mixed
    orgs) all throw stable `APPROVAL_POLICY_*` / `APPROVAL_POLICYSET_*`
    codes. An EMPTY set is legal — the org opted out entirely;
  - `defineApprovalPolicy` / `definePolicySet` — validated deep-frozen
    copies (policies are immutable data);
  - `evaluateApprovalRequirement(policies, request, clock)` — deterministic:
    no matching policy ⇒ EXEMPT (`NO_POLICY_MATCH`); threshold match is
    `amountMinor >= threshold` AT-boundary-requires-approval, same-currency
    only; threshold 0 always gates, even a zero-amount request; a threshold
    hit beats the catch-all; MOST SPECIFIC (highest qualifying threshold)
    wins; amount-less requests never exempt for `AMOUNT_REQUIRED_OPERATIONS`
    (`refund`, `write_off` — fail-closed: an unquantified loss never passes);
    the result carries the full evidence shape (matched policy COPY — the
    caller's input is never frozen — plus roles/quorum/ttl/evaluatedAt).
- **`request.ts`** — the `ApprovalRequest` aggregate and its lifecycle:
  - states `drafted → pending → approved | rejected | expired | cancelled`,
    `approved → applied`; `APPROVAL_TRANSITIONS` table; terminals have no
    outgoing edges;
  - `openApprovalRequest` (maker; snapshot payload is caller-redacted: opaque
    subject refs + amountMinor/currency + a ≤ 512-char summary — the lane
    never sees account numbers or customer PII), `submitApprovalRequest`
    (drafted → pending, no event — the catalog has no `requestSubmitted`),
    `approve` (role-checked, DISTINCT-approver quorum — a second approval by
    the same user never counts; `APPROVAL_SELF_APPROVAL_REFUSED` guard runs
    BEFORE the role check; below quorum the decision lands in the append-only
    log with NO state change), `reject` (reason required), `expire` (TTL
    sweep; refuses not-yet-due `APPROVAL_EXPIRY_NOT_DUE`), `cancel`
    (requester-only, while pending; a late cancel of an already-terminal
    post-live request is a redundant CUSTOMER action — refusal VALUE, while
    pre-live/post-decision table-illegal moves THROW),
    `markApplied` (approved-only; evidence bundle out).
  - every refusal: `{ accepted: false, refusal: { reasonCode, ... }, event }`
    with a stable `APPROVAL_*` code + `approvals.decisionRefused` fact.
- **`events.ts`** — `approvals.requestCreated / .approved / .rejected /
  .expired / .cancelled / .applied / .quorumMet` (exactly once, when the
  distinct-approver count crosses the quorum) / `.decisionRefused`.

## Stable codes (the audit vocabulary)

`APPROVAL_POLICY_INVALID`, `APPROVAL_POLICY_ORG_REQUIRED`,
`APPROVAL_POLICY_ID_REQUIRED`, `APPROVAL_POLICY_OPERATION_INVALID`,
`APPROVAL_POLICY_THRESHOLD_INVALID`, `APPROVAL_POLICY_CURRENCY_INVALID`,
`APPROVAL_POLICY_ROLES_REQUIRED`, `APPROVAL_POLICY_ROLE_INVALID`,
`APPROVAL_POLICY_ROLE_DUPLICATE`, `APPROVAL_POLICY_QUORUM_INVALID`,
`APPROVAL_POLICY_QUORUM_EXCEEDS_ROLES`, `APPROVAL_POLICY_TTL_INVALID`,
`APPROVAL_POLICYSET_INVALID`, `APPROVAL_POLICYSET_ORG_MISMATCH`,
`APPROVAL_POLICY_ORG_MISMATCH`, `APPROVAL_SNAPSHOT_INVALID`,
`APPROVAL_POLICY_ID_DUPLICATE`, `APPROVAL_POLICY_DUPLICATE`,
`APPROVAL_ORG_REQUIRED`, `APPROVAL_REQUEST_INVALID`, `APPROVAL_ID_REQUIRED`,
`APPROVAL_OPERATION_INVALID`, `APPROVAL_OPERATION_MISMATCH`,
`APPROVAL_SUBJECTS_REQUIRED`, `APPROVAL_SUBJECT_INVALID`,
`APPROVAL_SUBJECT_DUPLICATE`, `APPROVAL_AMOUNT_INVALID`,
`APPROVAL_AMOUNT_NOT_SAFE_INTEGER`, `APPROVAL_AMOUNT_REQUIRED`,
`APPROVAL_CURRENCY_INVALID`, `APPROVAL_SUMMARY_REQUIRED`,
`APPROVAL_SUMMARY_TOO_LONG`, `APPROVAL_REQUESTER_REQUIRED`,
`APPROVAL_ACTOR_REQUIRED`, `APPROVAL_APPROVER_REQUIRED`,
`APPROVAL_APPROVER_ROLES_INVALID`, `APPROVAL_APPROVER_DUPLICATE`,
`APPROVAL_SELF_APPROVAL_REFUSED`, `APPROVAL_ROLE_NOT_HELD`,
`APPROVAL_REASON_REQUIRED`, `APPROVAL_STATUS_INVALID`,
`APPROVAL_TRANSITION_NOT_AUTOMATIC`, `APPROVAL_TRANSITION_INVALID`,
`APPROVAL_NOT_DRAFTED`, `APPROVAL_NOT_PENDING`, `APPROVAL_REQUEST_EXPIRED`,
`APPROVAL_REQUEST_CANCELLED`, `APPROVAL_EXPIRY_NOT_DUE`,
`APPROVAL_CANCEL_NOT_REQUESTER`, `APPROVAL_QUORUM_NOT_MET`,
`APPROVAL_ALREADY_APPLIED`, `APPROVAL_NOT_APPROVED`,
`APPROVAL_CLOCK_INVALID`.

## Boundary contract (what this lane does NOT own)

- **Executing the operation** — the executor books the evidence bundle; the
  operation itself must be idempotent in ITS OWN lane.
- **Identity / who holds which role** — approvers arrive as
  `{ approverId, roleIds }` plain data (auth/RBAC stays in its lane).
- **Policy storage** — policies are plain data; persistence is an adapter.
- **The policy engine** (`src/domain/policy/`) — the caller maps a
  `require_approval` decision to an `ApprovalEvalRequest`; the lanes share
  the refusal-as-value philosophy, never imports.

# Policy lane — wave 5 (issue #34, VISION §3.9)

Owns **deterministic action governance** — the safety layer between AI (and
any automation) and financial execution:

```text
AI → recommendation → POLICY ENGINE → allow | deny | requires_approval → execution
```

**AI never decides what it is allowed to do.** Every automated or human-origin
action request is evaluated against the org's rule set; the engine answers
with a governed decision, a stable reason, the matched-rule audit trail and
— for every single evaluation — the `policy.decisionRecorded` audit fact.
Refusals are first-class facts, never silent (mirrors
`collections.dunningBlockedNoConsent` / `comms.sendBlockedNoConsent`).

## Scope

- **`request.ts`** — `ActionRequest`, the plain-data input (no aggregates,
  no lane imports; subject refs are opaque Uuids; consent/dispute/promise
  arrive as boolean FACTS the caller projects — the consent registry is never
  consulted here):
  - `actor: { type: human | ai_agent | integration, actorId }` — the actor id
    is opaque (no auth/RBAC in this lane; the caller owns identity);
  - `actionType` — governed vocabulary `send_reminder | send_whatsapp |
    send_sms | offer_payment_plan | issue_payment_link | escalate |
    write_off | refund`; any other string is structurally ACCEPTED and
    governed (denied) by the engine — garbage from a misbehaving automation
    gets an audited refusal, never an exception it could crash past;
  - subject refs `orgId / customerId / receivableId / caseId`;
  - `amountMinor` + `currency` (both or neither; non-negative safe integer,
    the promises-lane `number` minor-unit convention) — required for
    `write_off` / `refund`;
  - `riskClass: low | elevated | high`; `channel: email | sms | whatsapp | null`;
  - context flags `consentPresent / disputeOpen / promisePending / autonomous`;
    `autonomous` = would execute with NO human in the loop — a `human` actor
    claiming it is a contradiction (`POLICY_AUTONOMY_MISMATCH`);
  - `effectiveChannel` — explicit channel wins; `send_whatsapp` / `send_sms`
    imply theirs; `send_reminder` is channel-generic and must name one
    explicitly (default rules refuse autonomous contact without a channel).
  - Two-tier contract (house style, matching comms/guard.ts): MALFORMED
    input throws a stable `POLICY_*` `DomainError` (a bug, not a governance
    outcome); an UNKNOWN actionType is NOT malformed — it is a request the
    engine GOVERNS.

- **`rules.ts`** — rule sets are deterministic DATA, not code:
  - a `PolicyRule` = unique `id`, unique `priority` (lower = evaluated
    first; the order is total), `actionType` scope (`'any'` or one known
    action), ordered `conditions` (ALL must match — AND), a `decision`
    (`allow | deny | requires_approval`), a stable `POLICY_*` `reasonCode`,
    a human `explanation`, and optional `grants` (maxAmountMinor /
    allowedChannels / expiresAt) that a deny rule may never carry (a refusal
    grants nothing);
  - conditions are typed predicates over known fields with known operators —
    `actionType, actorType, riskClass, channel, amountMinor,
    minuteOfDayUtc, dayOfWeekUtc, consentPresent, disputeOpen,
    promisePending, autonomous` × `eq, ne, in, not_in, gt, gte, lt, lte,
    is_true, is_false, present, absent` — validated at creation (unknown
    fields, unknown operators, out-of-domain values, ordering ops on
    non-numeric fields, boolean ops on non-boolean fields, existence tests
    on non-nullable fields and malformed grants are all REFUSED — a typo'd
    rule is a security bug); `minuteOfDayUtc` (0–1439) and `dayOfWeekUtc`
    (0–6, 0 = Sunday) come from the injected Clock, so time windows are
    expressed with the same generic operators as everything else,
    deterministically; null facts only ever match `absent`;
  - a `PolicyRuleSet` is per-org, versioned (safe integer ≥ 1), immutable:
    `createRuleSet` validates + deep-copies + deep-freezes; rules are stored
    in ascending-priority order; `nextVersion` mints version + 1 as a NEW
    object — versions are never mutated; unique rule ids and unique
    priorities are enforced (`POLICY_RULE_ID_DUPLICATE` /
    `POLICY_RULE_PRIORITY_DUPLICATE`); an EMPTY rule set is legal — the
    maximally safe posture (everything falls through to fail-closed deny);
  - `DEFAULT_RULES` / `defaultRuleSetFor(orgId, clock)` ship the
    safe-by-default posture (below).

- **`engine.ts`** — `evaluate(request, ruleSet, clock)`: the pure decision
  function. Same rules + same request + same clock instant ⇒ the same
  decision, the same explanation and the same audit event, bit-for-bit
  (one Clock read per evaluation; `requestedAt === event.occurredAt`).
  Order: request validation → rule-set reference + org match → engine
  pre-guards (fail-closed, BEFORE any rule, so even a permissive custom rule
  set cannot allow-list an unknown action or an unquantified loss) →
  FIRST MATCH WINS over priority-ordered rules → fail-closed deny when
  nothing matches (`POLICY_NO_RULE_MATCHED` — silence never widens
  permissions). The returned `PolicyDecision` (and its event) is deep-frozen;
  inputs are never mutated.

- **`events.ts`** — `policy.decisionRecorded`, emitted for EVERY evaluation —
  `allow`, `deny` AND `requires_approval` (an approval demand is as auditable
  as a permission). Repo envelope `{ name, version: 1, aggregateId,
  occurredAt, payload }`; `aggregateId` is the org (there is no policy
  aggregate). The payload is deliberately NARROW and PII-free: subject ids,
  action type, actor KIND (never the actor id), autonomous flag, risk class,
  amount, effective channel, decision, reason code, matched rule ids, rule
  set version, instant. The explanation and the raw context flags stay on
  the decision/caller — not in the event payload.

## The safe-by-default posture (DEFAULT_RULES, in evaluation order)

| # | Rule | Decision | Reason |
|---|------|----------|--------|
| 10 | dispute open + autonomous | deny | `POLICY_DISPUTE_OPEN` |
| 20 | autonomous customer contact without consentPresent | deny | `POLICY_CONSENT_REQUIRED` |
| 30 | autonomous customer contact with no channel | deny | `POLICY_CHANNEL_REQUIRED` |
| 100 | write_off > KES 100,000 (any actor) | requires_approval | `POLICY_WRITE_OFF_APPROVAL_REQUIRED` |
| 101 | refund > KES 50,000 (any actor) | requires_approval | `POLICY_REFUND_APPROVAL_REQUIRED` |
| 120 | autonomous + risk elevated/high | requires_approval | `POLICY_RISK_APPROVAL_REQUIRED` |
| 900 | non-autonomous (human-supervised) | allow | `POLICY_SUPERVISED_ACTION` |
| 950 | autonomous + risk low | allow | `POLICY_AUTONOMOUS_LOW_RISK` |

Engine pre-guards (before any rule, unconditional): unknown actionType → deny
`POLICY_ACTION_UNKNOWN`; `write_off`/`refund` without an amount → deny
`POLICY_AMOUNT_REQUIRED`; a channel contradicting the action type → deny
`POLICY_CHANNEL_ACTION_MISMATCH`; no matching rule → deny
`POLICY_NO_RULE_MATCHED`.

Deliberate readings, pinned by tests: **humans bypass the autonomy
restrictions** (10/20/30/120 are autonomous-only) **but not the compliance
rules** (100/101 carry no autonomy condition); a disputed receivable blocks
AUTOMATED actions while humans stay unblocked (SPEC §29 pauses automation,
not collectors); thresholds are strict `>` (exactly-at-threshold is below the
approval line). Orgs that want a different posture publish a new rule-set
VERSION — the defaults are data, so overriding them is data too.

## Rules

- Import ONLY from `../shared` + own files. Consent, disputes, promises,
  cases and receivables are opaque Uuid ids / caller-projected boolean facts.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock` (and drives `minuteOfDayUtc` / `dayOfWeekUtc` /
  `requestedAt` / `occurredAt`).
- Outputs are frozen plain data; inputs are never mutated; rule-set versions
  are immutable (new rules = new version).
- Stable `DomainError` codes (SCREAMING_SNAKE, `POLICY_*` prefix):
  request — `POLICY_REQUEST_INVALID`, `POLICY_ORG_REQUIRED`,
  `POLICY_CUSTOMER_REQUIRED`, `POLICY_SUBJECT_INVALID`,
  `POLICY_ACTOR_REQUIRED`, `POLICY_ACTOR_TYPE_INVALID`,
  `POLICY_AUTONOMY_MISMATCH`, `POLICY_ACTION_TYPE_INVALID`,
  `POLICY_AMOUNT_INVALID`, `POLICY_CURRENCY_INVALID`,
  `POLICY_RISK_CLASS_INVALID`, `POLICY_CHANNEL_INVALID`,
  `POLICY_REQUEST_FLAG_INVALID`;
  rule set — `POLICY_RULESET_ORG_REQUIRED`, `POLICY_RULESET_VERSION_INVALID`,
  `POLICY_RULESET_RULES_INVALID`, `POLICY_RULESET_INVALID`,
  `POLICY_RULESET_ORG_MISMATCH`, `POLICY_RULE_ID_REQUIRED`,
  `POLICY_RULE_ID_DUPLICATE`, `POLICY_RULE_PRIORITY_INVALID`,
  `POLICY_RULE_PRIORITY_DUPLICATE`, `POLICY_RULE_INVALID`,
  `POLICY_RULE_ACTION_INVALID`, `POLICY_RULE_DECISION_INVALID`,
  `POLICY_RULE_REASON_INVALID`, `POLICY_RULE_EXPLANATION_REQUIRED`,
  `POLICY_RULE_CONDITIONS_INVALID`, `POLICY_RULE_FIELD_UNKNOWN`,
  `POLICY_RULE_OPERATOR_INVALID`, `POLICY_RULE_CONDITION_VALUE_REQUIRED`,
  `POLICY_RULE_CONDITION_VALUE_FORBIDDEN`,
  `POLICY_RULE_CONDITION_VALUE_INVALID`, `POLICY_RULE_GRANT_INVALID`;
  engine — `POLICY_ACTION_UNKNOWN`, `POLICY_NO_RULE_MATCHED`,
  `POLICY_AMOUNT_REQUIRED`, `POLICY_CHANNEL_ACTION_MISMATCH`,
  `POLICY_CLOCK_INVALID`; events — `POLICY_AMOUNT_NOT_SAFE_INTEGER`.
- Catalog registration for `policy.*` (docs/04) stays with the events lane
  owner, matching wave-3/4 precedent.

## Out of scope (issue #34)

Executing anything, consent-registry access (callers pass facts), auth/RBAC
(the actor is an opaque id + type). An `allow` here does NOT mean "sent" —
downstream gates (the comms K2 guard, execution lanes) still apply. Consumers:
the agent lane (F21) previews/executes actions through this gate; the NBA lane
(F22) filters its recommendations through it.

## Definition of done

- Table-driven decision matrix (actor × action × amount × risk × consent ×
  dispute × channel × time) over the default posture; rule-set versioning +
  validation-refusal tables; safe-by-default unknown-action denial (also
  against a permissive custom rule set); first-match-wins precedence; grant/
  condition propagation; requires_approval paths; audit event shape for
  allow AND deny AND requires_approval (narrow payload, no PII, envelope
  pins); determinism, immutability and no-mutation pins.
- `npm run typecheck && npm test` green.

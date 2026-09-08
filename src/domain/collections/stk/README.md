# STK-push execution lane — RICE #2 (wave 11, issue #92)

Owns **"collect now via STK push"** — the policy-gated collections execution
action that converts next-best-action output into rail-native M-Pesa money
movement (M-Pesa Express / Lipa na M-Pesa Online). STK is the rail-native way
Kenyans pay; this lane is the EXECUTION composition point over the existing
pure cores:

```text
NBA economics → proposeStkPush
  → gateStkPush   = DPA consent gate (consent lane, K2/K3) THEN policy engine (F20)
      deny               → refused        (machine-readable reason + compliance event)
      requires_approval  → awaiting_approval → approveStkPush → approved
      allow              → proposed (decision handle stamped)
  → initiateStkPush   (injected StkPushWire port → the Go Daraja client)
      accepted → initiated (checkoutRequestId + R9 initiation key + TTL deadline)
      rejected → unchanged (retryable; stk.pushNotInitiated on the record)
  → reconcileStkCallback  (through the EXISTING payments intake core)
      success → payment awaited + confirmed (existing transitions) → reconciled
      failure → payment failed (existing transition)               → failed
      duplicate → the SAME payment + payments.duplicateCallbackObserved (R9)
  → expireStkPushIfDue    (the stuck path: initiated → timed_out at the TTL;
                           a late callback still lands, stamped resolvedLate)
```

## Files

- **`events.ts`** — the lane's facts in the repo envelope
  (`{name, version: 1, aggregateId, occurredAt, payload}`), narrow/serializable
  payloads, minor units as safe-integer numbers (R10), **never the MSISDN**
  (PII lives on the aggregate only — pinned by tests).
- **`wire.ts`** — the injected `StkPushWire` port (initiation command +
  accepted/rejected outcome; synchronous-pure in the core, comms-lane
  precedent), the validated `StkPushResultCallback` boundary, and the two
  deterministic R9 keys:
  - `stkpush:<actionId>` — retry-safe INITIATION key;
  - `daraja:stk:<checkoutRequestId>` — PAYMENT journey key, byte-identical to
    the daraja conformance convention (`src/adapters/daraja/wire.ts`) so both
    doors land on the same payment.
- **`actions.ts`** — the `StkPushAction` aggregate + the full lifecycle:
  `proposeStkPush` (validates KES integer minor units, reuses the ussd lane's
  `normalizeMsisdn`, recomputes the NBA score from its parts), `applyStkPolicyDecision`,
  `approveStkPush`, `initiateStkPush` (validates the allow clearance: amount
  ceiling, channel, expiry), `reconcileStkCallback` (intake → existing
  `awaitConfirmation`/`confirmPayment`/`failPayment`), `expireStkPushIfDue`.
- **`gate.ts`** — `gateStkPush`: consent FIRST (`assertCanContact` on
  `(customer, sms, dunning)` — a DPA refusal is final and the engine never
  sees the request), then the REAL `evaluate()` with a real `ActionRequest`
  (`actionType: 'collect_now_stk_push'`); emits the engine's existing
  `policy.decisionRecorded` for EVERY evaluation plus the lane's refusal /
  awaiting-approval facts.
- **`audit.ts`** — every lane event projects into the EXISTING §37 unified
  trail via `auditFromEvent` with the closed `AUDIT_ACTIONS` vocabulary
  (`create`/`transition`/`approve`/`send`/`ingest`), exhaustive by type.

## Rules

- Pure functions only: injected `Clock`, deterministic ids (`uuidFromSeed`),
  no I/O, no RNG, no `Date.now()`. Fakes exist only in tests; the production
  wire adapter ships in the Go client's lane.
- Money ONLY via `Money` in KES integer minor units (R10); STK is KES-only;
  safe-integer ceiling asserted so amounts cross the policy request and event
  payloads losslessly. No floats anywhere.
- Append-only discipline (R3): transitions return fresh aggregates; nothing
  is mutated in place, nothing removed.
- Fund truth: NOTHING outside the existing intake/match core. The callback
  flows through `intakePayment` (R9 — a duplicate returns the SAME payment and
  emits `payments.duplicateCallbackObserved`); success metadata must equal the
  initiated amount exactly or the callback is refused as tampered (K1) before
  anything is written.
- Refusal is a first-class outcome (the K2 pattern): consent and policy
  refusals return VALUES with machine-readable reason codes (the consent
  lane's `RefusalReason`, the engine's `POLICY_*` codes) and emit
  `stk.pushRefused` compliance events. Only malformed input throws stable
  `STK_*` codes.

## Cross-lane notes (reported, not changed here)

- **policy lane**: `collect_now_stk_push` must join the governed
  `ACTION_TYPES` vocabulary in `src/domain/policy/request.ts` (plus, if
  desired, a `DEFAULT_RULES` row). Until then the engine's documented
  safe-by-default pre-guard denies every STK request
  (`POLICY_ACTION_UNKNOWN`) — the gate handles all three outcomes either way,
  so the lane is correct the moment the vocabulary lands.
- **collections lane**: `stkPush` may join `CASE_ACTION_TYPES` when the case
  log wants to record pushes as case activity; this lane keeps its own
  execution aggregate and does not depend on it.
- **nba lane**: an `stk_push` candidate may join `NBA_ACTIONS`; the
  economics shape here mirrors the ranking expression already.
- **Go Daraja client** (another team): implement `StkPushWire` + translate
  raw callbacks through `src/adapters/daraja/wire.ts` before this boundary.

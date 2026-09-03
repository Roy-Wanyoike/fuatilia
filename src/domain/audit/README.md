# `domain/audit` — the unified append-only audit trail (issue #53, SPEC §37)

One trail for every important action: organization, actor, action, entity,
entity id, timestamp, request id, correlation id, ip/user-agent where
appropriate, previous state, new state, reason, approval information — and
`aiContext`, which makes AI actions auditable as such (agent kind + evidence
refs, VISION §3.8). Per-lane audit events already exist; this lane is the
**unified trail they project into**.

## Modules

| File | Owns |
|---|---|
| `redact.ts` | Recursive, case-insensitive stripping of forbidden keys (`password`, `secret`, `token`, `apiKey`, `authorization`, `pin` — containment match, so `client_secret` / `access_token` / `api_key` / `PIN_code` die too) from state snapshots BEFORE persistence; deep-frozen outputs, non-destructive inputs, `AUDIT_SNAPSHOT_INVALID` for structure that could not hash losslessly |
| `record.ts` | `AuditRecord` (every §37 field, plus the chain fields), the closed `AuditAction` vocabulary (16 stable verbs), `AuditActor` / `AuditApproval` / `AuditAiContext`, `buildAuditDraft` (validate → stamp from Clock → redact → freeze), `assertRecordShape`, the **append-only `AuditSink` port** (ONLY `append(record) → AuditRecord` — no update/delete exists at the type level) and the deterministic `createInMemoryAuditSink(clock)` (re-redacts, deep-freezes, refuses future `occurredAt` and duplicate `auditId`s) |
| `chain.ts` | Tamper evidence: injected `AuditHashPort` (auth/apikeys codec precedent — no crypto import), deterministic canonical JSON (recursively key-sorted), `recordHash = H(prevHash ‖ canonical(record))` with `prevRecordHash` linkage (genesis anchor `GENESIS_PREV_HASH`), `appendAuditRecord` (THE append path: validate → redact → hash → sink), `verifyChain` → stable `AUDIT_CHAIN_BROKEN` evidence values |
| `project.ts` | `auditFromEvent(envelope, options)` — plain event envelope → complete §37 draft (no lane imports; entityType = the event name's context, entityId = aggregateId, envelope instant preserved); `queryAuditTrail(records, filter)` — read-only filter (org / actor / entity / inclusive time-range / correlation / request / action) with stable sort (occurredAt, then auditId) |
| `events.ts` | `audit.recordAppended` — the ONE lane fact, narrow payload (ids, actor kind, action, entity, request/correlation, chain hashes, instant); detail lives on the record, never on the bus |

## Invariants

1. **Append-only, twice over.** The `AuditSink` port exposes only `append`;
   and each record is chained to its predecessor
   (`recordHash = H(prevHash ‖ canonical(record))`), so a rewritten,
   removed or reordered record is DETECTABLE, not just forbidden.
2. **Redaction cannot be bypassed.** The append path redacts before hashing
   AND the sink re-redacts before storing — even a direct `sink.append`
   cannot persist a forbidden key, and the chain attests exactly the
   redacted form that was stored.
3. **Tampering is evidence, not an exception.** `verifyChain` returns
   decision values with the stable `AUDIT_CHAIN_BROKEN` code and a reason
   (`RECORD_HASH_MISMATCH` mutation, `PREV_HASH_MISMATCH` removal/reorder,
   `GENESIS_INVALID` (a dropped genesis — the survivor still claims its
   predecessor), `HASH_FIELD_MALFORMED`, `LENGTH_MISMATCH` /
   `HEAD_MISMATCH` truncation against an anchored expectation). Honest
   limit: a hash chain cannot see TAIL truncation from the inside — pass
   `expected.length` / `expected.headHash` (from the last external anchor)
   to close it; tests pin both the catch and the limit.
4. **Fresh immutable copies.** Inputs are never mutated; drafts, records
   and snapshots come back deep-frozen; `queryAuditTrail` returns a fresh
   array and leaves the trail untouched.
5. **Closed vocabulary, deny-by-default.** Actions come from the 16-verb
   `AUDIT_ACTIONS` table; projections never guess an action; malformed
   anything throws a stable `AUDIT_*` `DomainError` and nothing partial is
   ever persisted.
6. **Determinism.** No I/O, no RNG, no `Date.now()` — time via the injected
   `Clock` (`AUDIT_CLOCK_INVALID` when broken); the sink refuses records
   from the future (`AUDIT_OCCURRED_AT_FUTURE`); hash input is canonical
   JSON with recursively sorted keys, so replays hash identically.

## Stable error codes

`AUDIT_ACTOR_INVALID`, `AUDIT_ACTION_INVALID`, `AUDIT_AI_CONTEXT_INVALID`,
`AUDIT_APPROVAL_INVALID`, `AUDIT_AUDIT_ID_TAKEN`, `AUDIT_CHAIN_BROKEN`*
(evidence value), `AUDIT_CLOCK_INVALID`, `AUDIT_CORRELATION_ID_INVALID`,
`AUDIT_ENTITY_ID_REQUIRED`, `AUDIT_ENTITY_TYPE_REQUIRED`,
`AUDIT_EVENT_NAME_MALFORMED`, `AUDIT_EVENT_OCCURRED_AT_INVALID`,
`AUDIT_EVENT_PAYLOAD_INVALID`, `AUDIT_FILTER_INVALID`,
`AUDIT_HASH_MALFORMED`, `AUDIT_HASH_PORT_INVALID`,
`AUDIT_IP_MALFORMED`, `AUDIT_OCCURRED_AT_FUTURE`,
`AUDIT_OCCURRED_AT_INVALID`, `AUDIT_ORG_REQUIRED`, `AUDIT_REASON_MALFORMED`,
`AUDIT_RECORD_MALFORMED`, `AUDIT_REQUEST_ID_REQUIRED`,
`AUDIT_SNAPSHOT_INVALID`, `AUDIT_USER_AGENT_MALFORMED`.

\* `AUDIT_CHAIN_BROKEN` is a RETURNED evidence code on
`ChainVerification` (breaks are facts, not crashes); `expected.length`
validation inside `verifyChain` throws `AUDIT_FILTER_INVALID` for a
malformed expectation.

## Events

`audit.recordAppended` — repo envelope v1
`{ name, version, aggregateId: auditId, occurredAt, payload }`; payload is
narrow and PII-free (no snapshots, no reason/approval/aiContext, no
ip/user-agent). Catalog registration for `audit.*` stays with the events
lane owner, matching wave-3/4/6 precedent.

## Out of scope

Storage adapters, retention, external anchoring/scheduling of
`expected.headHash`, the approval lane itself (the `approval` bundle is an
opaque ref), and the HTTP transport that will expose
`queryAuditTrail` (wave 7).

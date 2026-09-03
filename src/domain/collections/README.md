# Collections module — wave 3 (issue #8)

Owns the Collections lane's work unit: the `CollectionsCase` that drives
dunning on one or more receivables, its append-only action log, the **R8
case-exclusivity invariant** (review finding H6) and the **K2 dunning-consent
hook** (Kenya DPA 2019 / Meta policy).

## Scope
- `CollectionsCase` — covers ≥ 1 receivable (opaque ids), owned by a collector
  (opaque id), with a `low | normal | high | urgent` priority and a per-org
  controlled `caseNumber` sequence (`CASE-000007` by default; formatter is
  injectable, the per-org counter lives with the adapter).
- **Stored lifecycle** (issue #8; docs/03):
  `open → in_progress → resolved | closed_inactive` (the last two terminal).
  Engaging (`open → in_progress`) emits no lane event — engagement is visible
  through recorded actions + the history log.
- **Derived statuses — never stored:** `waiting | promised | disputed` are
  computed by the pure `deriveCaseStatus(case, childFacts)` from PLAIN DATA
  (`promiseFacts: {receivableId, status: 'pending'|'fulfilled'|'broken'}[]`,
  `disputeFacts: {receivableId, open}[]`). Matrix (first match wins):
  terminal → as-is; open dispute on a covered receivable → `disputed`;
  pending promise → `promised`; else → `waiting` (fulfilled/broken promises
  are not promises — the d11 response to a broken promise is an escalation,
  not a stored state). Facts on non-covered receivables are ignored.
- **R8 exclusivity (core invariant):** at most one OPEN case per receivable.
  `openCase(args, openCaseCoverage, clock)` receives the existing open-case
  coverage as plain data (`{receivableId, caseId}[]`) and rejects any new
  case whose receivables intersect it (`CASE_ALREADY_OPEN`, details name the
  conflicting pair). A multi-receivable case covers A+B ⇒ blocks new cases on
  A and on B. Closing a case RELEASES its receivables: `openCaseCoverageOf`
  projects coverage from case aggregates (only open cases contribute), so a
  re-open after close is a fresh `openCase` against updated coverage.
- **Action log (append-only, R3 discipline):** `recordAction(case, {type,
  scheduledFor, outcome?, actorId, source?, consentRef?})` appends one of
  `call | sms | whatsapp | letter | fieldVisit | escalation` and emits
  `case.actionRecorded`. A recorded `outcome` means it already happened
  (backfill: completed at record time). `completeAction(case, actionId,
  {outcome, actorId?}, clock)` stamps `outcome + completedAt + completedBy`
  on a fresh copy; completing twice is refused. Terminal cases seal the log.
- **K2 dunning-consent hook:** automated outbound sends (`sms`/`whatsapp`,
  the `OUTBOUND_ACTION_TYPES`) require an opaque `consentRef` (the customer's
  active dunning consent grant, referenced by id only). Missing ⇒ rejected
  with `DUNNING_CONSENT_REQUIRED` and NOT appended; `tryRecordAction`
  surfaces the rejection as a value together with the
  `collections.dunningBlockedNoConsent` compliance event (refusal-as-value,
  same pattern as the consent lane's guard). `sms`/`whatsapp` default to
  `source: 'automated'` — fail-closed so a forgotten flag never bypasses the
  gate; `manual` sends need no consent.
- `escalateCase(case, {to, reason, actorId}, clock)` strictly raises the
  priority (low → normal → high → urgent), appends to the priorityChanges
  log and emits `case.escalated`.

## Events (`./events.ts`, envelope `{name, version, aggregateId, occurredAt, payload}`)
`case.opened` (the R8 coverage fact) · `case.actionRecorded` ·
`case.escalated` · `case.resolved` · `case.closed` (payload carries
`releasedReceivableIds` — the R8 release fact) ·
`collections.dunningBlockedNoConsent` (the K2 refusal fact). Dates travel as
ISO-8601 strings; cross-lane ids as opaque Uuids.

## Rules
- Import ONLY from `../shared`. Reference receivables/promises/disputes/
  consent by opaque `Uuid` — never import another lane's types.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`; every operation returns a fresh immutable copy.
- Stable `DomainError` codes (SCREAMING_SNAKE, `CASE_*` prefix for lane
  rules + `DUNNING_CONSENT_REQUIRED` for the K2 gate): `CASE_ALREADY_OPEN`,
  `CASE_RECEIVABLES_REQUIRED`, `CASE_RECEIVABLE_INVALID`,
  `CASE_RECEIVABLE_DUPLICATE`, `CASE_COLLECTOR_REQUIRED`, `CASE_PRIORITY_INVALID`,
  `CASE_SEQUENCE_INVALID`, `CASE_NUMBER_INVALID`, `CASE_CLOCK_INVALID`,
  `CASE_STATUS_INVALID`, `CASE_TRANSITION_INVALID`, `CASE_REASON_REQUIRED`,
  `CASE_ACTOR_REQUIRED`, `CASE_CLOSED`, `CASE_ESCALATION_INVALID`,
  `CASE_ACTION_TYPE_INVALID`, `CASE_ACTION_SOURCE_INVALID`,
  `CASE_ACTION_ID_REQUIRED`, `CASE_SCHEDULED_FOR_INVALID`,
  `CASE_CONSENT_REF_INVALID`, `CASE_OUTCOME_REQUIRED`, `CASE_ACTION_NOT_FOUND`,
  `CASE_ACTION_ALREADY_COMPLETED`, `CASE_PROMISE_STATUS_INVALID`,
  `CASE_DISPUTE_FACT_INVALID`.

## Definition of done
- Lifecycle grid (legal + illegal), R8 exclusivity + release/re-open,
  derived-status matrix, action log discipline, consent-blocked sends and
  escalation ladder — all table-driven tested.
- `npm run typecheck && npm test` green.

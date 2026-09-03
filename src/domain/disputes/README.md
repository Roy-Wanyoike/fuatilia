# Disputes lane — wave 3 (issue #20, SPEC §29)

Owns the dispute lifecycle over a receivable and the one rule that makes
disputes a first-class collections concern: **a disputed invoice must not
blindly continue aggressive collection automation** (SPEC §29).

## Scope

- `Dispute` aggregate — the customer's challenge to a receivable: per-org
  controlled `disputeNumber` (e.g. `DSP-000014`), `orgId`, `receivableId`
  (opaque), `category` (`pricing | quality | quantity | delivery | duplicate |
  other`), `description`, `evidenceRefs` (opaque), `assignedTo` (opaque user
  id), `openedAt`, `status`.
- Lifecycle (docs/03 states; legal table = `DISPUTE_TRANSITIONS`):

  ```text
  opened            → investigating | cancelled
  investigating     → awaiting_customer | awaiting_business
                    | resolved | rejected | cancelled
  awaiting_customer → investigating | resolved | rejected | cancelled
  awaiting_business → investigating | resolved | rejected | cancelled
  resolved | rejected | cancelled   ← terminal, nothing re-opens them
  ```

  Skipping `investigating` from `opened`, hopping between the two awaiting
  states without returning to `investigating`, and any transition out of a
  terminal state are all illegal (`DISPUTE_TRANSITION_INVALID`).
- **Exclusivity:** at most ONE open dispute per receivable — a second
  `openDispute` on the same receivable throws `DISPUTE_ALREADY_OPEN`. Once the
  open dispute reaches a terminal state, a new dispute may be opened (a fresh
  sequence number, append-only — the old dispute is never re-opened).
- **Collections pause (the core product rule):** opening a dispute emits the
  typed PAUSE fact (`dispute.opened`); every terminal transition emits a
  RESUME fact (`dispute.resolved` / `dispute.rejected` / `dispute.cancelled`).
  The pure policy lives in `pause.ts`:
  - `collectionsHoldFor(disputeStates)` — the dispute states recorded against
    one receivable ⇒ is collections on hold? (any live state ⇒ true);
  - `automatedCollectionAllowed(disputeFacts)` → boolean — the gate
    collections automation must pass before dunning: ANY open dispute on the
    receivable ⇒ `false`. Facts are plain data (`DisputeFacts`), assembled by
    the consumer from a projection — no aggregate or transition-logic import;
  - `toDisputeFacts(dispute)` — projects the aggregate to its facts row.
- **Resolution carries an outcome decision** (`DisputeOutcome`): `resolved`
  with an optional remedy — `{ remedy: 'none' }` (default) or a reference to
  the correction applied in another lane: `{ remedy: 'credit_note',
  creditNoteId }` (opaque) or `{ remedy: 'write_off', writeOffId }` (opaque) —
  plus a mandatory reason.
- **Audit-friendly by construction:** every transition records
  `reason` + `actorId` + timestamp, appended to the aggregate's
  `history` log (append-only, R3 discipline — never rewritten, never deleted).
- Lane events (`events.ts`), repo naming `<context>.<aggregate><PastTenseVerb>`:
  `dispute.opened`, `dispute.statusChanged`, `dispute.resolved`,
  `dispute.rejected`, `dispute.cancelled`. Non-terminal steps emit
  `dispute.statusChanged`; terminal steps emit their dedicated RESUME event.
  (SPEC §34 lists `dispute.created`/`dispute.resolved` for the API surface;
  the lane's canonical names follow the repo catalog convention above.)

## Rules

- Import ONLY from `../shared`. Receivables, credit notes, write-offs and user
  accounts are referenced by opaque `Uuid` ids; collections lanes consume this
  lane through `pause.ts`'s plain-data policy and the event payloads.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`; aggregates are immutable, operations return fresh copies.
- Stable `DomainError` codes (SCREAMING_SNAKE, `DISPUTE_*` prefix):
  `DISPUTE_CATEGORY_INVALID`, `DISPUTE_DESCRIPTION_REQUIRED`,
  `DISPUTE_ACTOR_REQUIRED`, `DISPUTE_REASON_REQUIRED`, `DISPUTE_CLOCK_INVALID`,
  `DISPUTE_SEQUENCE_INVALID`, `DISPUTE_SEQUENCE_OUT_OF_ORDER`,
  `DISPUTE_NUMBER_INVALID`, `DISPUTE_NUMBER_TAKEN`, `DISPUTE_ID_TAKEN`,
  `DISPUTE_ALREADY_OPEN`, `DISPUTE_EVIDENCE_INVALID`, `DISPUTE_STATUS_INVALID`,
  `DISPUTE_TRANSITION_INVALID`, `DISPUTE_OUTCOME_INVALID`.
- The per-org dispute-number counter lives with the caller (adapter); the lane
  validates the sequence (safe integer ≥ 1, strictly newer than the org's
  latest used sequence) and the number's uniqueness within the org.

## Definition of done

- Lifecycle table-driven tested: every legal transition AND every illegal one
  (the full 7×7 state grid), second-open-dispute rejection per status,
  sequence/number validation, outcome-decision validation, pause/resume
  policy correctness.
- `npm run typecheck && npm test` green.

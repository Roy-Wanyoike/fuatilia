# Consent module — wave 2 (issue #10)

Owns the Customer & Consent lane's lawful-basis record: who may be contacted, on which
channel, for which purpose — and the audit trail proving it (Kenya Data Protection Act
2019, review findings K2/K3), plus the pure eTIMS invoice-numbering hook (K4).

## Scope
- `ConsentGrant` — one row per (customer, channel, purpose) consent event with
  `grantedAt`/`revokedAt` (docs/05 data dictionary). Channels: `whatsapp | sms | email`.
  Purposes: `dunning | marketing`.
- **Revocation is append-only (K3/R3):** `revokeConsent` never deletes or mutates a grant —
  it stamps `revokedAt` on a new immutable copy and the original row stays in the registry.
- **Re-grant after revocation creates a NEW grant row.** The (granted → revoked → granted)
  chain is the audit trail; nothing is ever updated in place.
- `assertCanContact(grants, request, clock)` — the pure contact guard (K2). WhatsApp dunning
  REQUIRES an active `whatsapp`/`dunning` grant (Meta policy); marketing consent never
  unlocks dunning. Returns an allowed decision with the supporting grant, or a **typed
  refusal** (`NO_GRANT | REVOKED | WRONG_PURPOSE | WRONG_CHANNEL`) — a refusal is a valid
  outcome, not an error; the guard throws only on invalid input.
- eTIMS numbering (K4): `createNumberingService(sequenceSource, clock)` reserves invoice
  numbers in the KRA eTIMS shape `KE<YYYY><8-digit zero-padded sequence><check character>`.
  The sequence source is injected (I/O stays outside); the check character is a documented
  mod-97-style alphanumeric checksum. `validateInvoiceNumber(raw)` parses + verifies.
- DSAR export (K3): `consentTrail(grants, customerId)` projects the chronological
  consent trail (`granted[]`, `revoked[]`, `active[]`) for a Data Protection Act 2019
  subject-access export.

## Rules
- Import ONLY from `../shared`. Other modules (Collections dunning, Receivables invoicing)
  reference this lane through its pure functions and opaque `Uuid` ids.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the injected `Clock`.
- Stable `DomainError` codes (SCREAMING_SNAKE, `CONSENT_*` / `ETIMS_*` prefix) for invalid
  input and registry violations; refusals are values, never exceptions.

## Definition of done
- Grant/revoke lifecycle, guard decision table, eTIMS format/checksum/parser, DSAR
  projection — all table-driven tested (legal + illegal paths).
- `npm run typecheck && npm test` green.

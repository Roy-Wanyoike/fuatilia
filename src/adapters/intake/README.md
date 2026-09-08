# Accounting intake (`src/adapters/intake/`)

**RICE #5 / issue #87 (wave 11, lane 11-f)** — the bulk/external door into the EXISTING pure
intake functions (`createInvoice → addInvoiceLine → issueInvoice → openReceivable`,
`intakePayment`). Buyers won't re-key invoices; global AR tools live or die by ERP sync. The
adapter composes; the domain validates; NOTHING persists by itself.

## Files

| File | Role |
|---|---|
| `csv.ts` | Bulk CSV invoice import: explicit column config (no auto-magic), RFC-4180-subset parser, strict money parsing (integer minor units; thousands separators / negatives / zeros / >2dp / overflow refused), ISO due dates, row errors AGGREGATED as typed refusal values (every bad row, not first-fail), all-or-nothing via the caller's transactional `commit` seam, batch idempotency (no-op replay returns the FIRST result; same key + different content refused via content hash), KES-only with honest multi-currency refusal (no FX lane is wired into intake — R10). |
| `accounting.ts` | Read-only pull mappers for QuickBooks + Zoho Books invoice JSON into the real receivables intake (totals recomputed from lines — precomputed totals never trusted; extra fields tolerated; missing required fields = typed refusals), and the accounting-payment rule: a payment maps into the REAL payments funnel ONLY when it carries a Daraja-shaped `mpesaTransactionId` (a live callback then dedupes under R9) — anything else is refused rather than inventing channel truth. |

## The batch contract

```
importCsvInvoices({ batchKey, orgId, csv, store, clock, commit })
  → header_invalid | row_errors (ALL rows) | currency_refused
  | duplicate_replay (first result, commit NOT re-run)
  | duplicate_key_content_mismatch
  | imported (→ commit(prepared, meta) — the caller's transaction)
```

## Honesty rules

- Money NEVER touches a float: CSV strings are parsed digit-by-digit into BigInt minor units;
  accounting JSON amounts (the ONE wire float) must round-trip to ≤2dp or are refused.
- Non-KES is refused as a VALUE, not exchanged — the FX kernel exists (src/domain/shared/fx.ts)
  but no FX lane is wired into receivables/payments intake.
- An ERP payment record is not M-Pesa money: without a Daraja-shaped reference the mapper
  refuses. Truth over convenience.
- Tests never touch network or disk: in-memory batch store, recorded commits, fixed clocks.

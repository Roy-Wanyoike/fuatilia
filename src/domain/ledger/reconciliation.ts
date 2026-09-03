/**
 * Daily sub-ledger ↔ GL reconciliation job — F11 (issue #18; K5, R4).
 *
 * K5 (docs/06): "Posting matrix (docs/05) is the contract between Fuatilia and
 * the accounting system; daily reconciliation job." The job proves R4's
 * financial-closing property every day, per org + currency:
 *
 *     Σ(open receivable balances)  ==  AR_CONTROL net balance
 *
 *   - sub-ledger side: Σ(open receivable balances) — plain data projected from
 *     the receivables lane (opaque ids only);
 *   - GL side: the AR_CONTROL balance DERIVED from the posted journal entries
 *     (Σ debits − Σ credits) — the exact lines a GL export would carry.
 *
 * Reversed entries need no special-casing: append-only math cancels them (a
 * reversal re-flips the original's lines), which is precisely why R3's
 * "correct by reversing, never editing" keeps the ledger reconcilable.
 *
 * The job is a pure FUNCTION over a deterministic JOB SPEC ("driver shape"):
 * the spec carries the run date ('YYYY-MM-DD'), org and currency, and the job
 * id is derived from exactly those (uuidFromSeed) — running the same spec over
 * the same inputs yields byte-identical results, forever. As-of-date filtering
 * of the inputs is an adapter concern (the core reconciles the snapshots it
 * is given).
 *
 * Outcomes (a drift is an EXCEPTION RESULT — a typed value, not a throw):
 *   - outcome 'ok'    → ledger.reconciliationMatched (the positive signal);
 *   - outcome 'drift' → ReconciliationDrift + ledger.reconciliationDriftDetected.
 * DomainErrors (stable LEDGER_RECON_* codes) are reserved for malformed input.
 */
import { DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import { assertEntryId } from './accounts';
import type { JournalLine } from './accounts';
import { arControlBalanceMinor } from './journal';
import type { Ledger } from './journal';
import { reconciliationDriftDetectedEvent, reconciliationMatchedEvent, minorUnits } from './events';
import type { ReconciliationDriftDetectedEvent, ReconciliationMatchedEvent } from './events';
import { uuidFromSeed } from './ids';

/** One open receivable's balance — plain data from the receivables projection. */
export interface OpenReceivableBalance {
  /** Opaque receivable id — the ledger never imports the receivables lane. */
  readonly receivableId: Uuid;
  readonly orgId: string;
  readonly currency: Currency;
  /** ≥ 0, integer minor units (a negative balance is a projection bug). */
  readonly balanceMinor: number | bigint;
}

/**
 * The deterministic job driver shape: date parameter + scope, with a job id
 * derived from all three. Build with `dailyReconciliationJob`.
 */
export interface DailyReconciliationJobSpec {
  readonly jobId: Uuid;
  readonly orgId: string;
  readonly currency: Currency;
  /** 'YYYY-MM-DD' — the day this reconciliation is run FOR (determinism key). */
  readonly runDate: string;
}

const RUN_DATE = /^\d{4}-\d{2}-\d{2}$/;

const assertRunDate = (runDate: string): string => {
  if (typeof runDate !== 'string' || !RUN_DATE.test(runDate) || Number.isNaN(new Date(`${runDate}T00:00:00.000Z`).getTime())) {
    throw new DomainError(
      'LEDGER_RECON_DATE_INVALID',
      `runDate must be a real calendar date 'YYYY-MM-DD', got ${String(runDate)}`,
      { runDate: String(runDate) },
    );
  }
  return runDate;
};

/**
 * Build the job spec for one daily run. The jobId is a pure function of
 * (orgId, currency, runDate) — the same day never gets two job ids.
 */
export const dailyReconciliationJob = (
  orgId: string,
  currency: Currency,
  runDate: string,
): DailyReconciliationJobSpec => {
  const date = assertRunDate(runDate);
  if (typeof orgId !== 'string' || !orgId.trim()) {
    throw new DomainError('LEDGER_ORG_REQUIRED', 'a reconciliation job requires a non-blank orgId');
  }
  return {
    jobId: uuidFromSeed(`ledger.recon:${orgId}:${currency}:${date}`),
    orgId,
    currency,
    runDate: date,
  };
};

/** The job's inputs: the two plain-data snapshots to reconcile. */
export interface ReconciliationJobInputs {
  /** Open receivable balances (sub-ledger side) — may span currencies. */
  readonly openReceivableBalances: readonly OpenReceivableBalance[];
  /** The append-only journal (GL side) — may span currencies. */
  readonly postedEntries: Ledger;
}

const balanceMinorOf = (value: number | bigint, code: string, label: string): bigint => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new DomainError(code, `${label} must be an integer minor unit, got ${String(value)}`, {
      [label]: String(value),
    } as Record<string, unknown>);
  }
  const minor = typeof value === 'number' ? BigInt(value) : value;
  if (minor < 0n) {
    throw new DomainError(
      code,
      `${label} cannot be negative (receivables are never over-settled), got ${minor}`,
      { [label]: minor.toString() } as Record<string, unknown>,
    );
  }
  return minor;
};

export interface ReconciliationCommon {
  readonly job: DailyReconciliationJobSpec;
  /** Σ(open receivable balances) in scope, minor units. */
  readonly subLedgerBalanceMinor: bigint;
  /** AR_CONTROL net balance in scope (Σ Dr − Σ Cr), minor units. */
  readonly glBalanceMinor: bigint;
  /** subLedgerBalanceMinor − glBalanceMinor (signed). */
  readonly driftMinor: bigint;
  readonly openReceivableCount: number;
  readonly postedEntryCount: number;
}

/** Zero drift — the books agree; the event is the positive daily signal. */
export interface ReconciliationOk extends ReconciliationCommon {
  readonly outcome: 'ok';
  readonly event: ReconciliationMatchedEvent;
}

/** THE typed exception result (K5): the sub-ledger and the GL disagree. */
export interface ReconciliationDrift extends ReconciliationCommon {
  readonly outcome: 'drift';
  readonly event: ReconciliationDriftDetectedEvent;
}

export type ReconciliationResult = ReconciliationOk | ReconciliationDrift;

/**
 * Run the daily reconciliation job. Pure: same job spec + same inputs ⇒ same
 * result (event timestamps come from the injected Clock).
 *
 * Scope handling:
 *   - balances/entries for ANOTHER org are rejected (LEDGER_RECON_SCOPE_MISMATCH) —
 *     cross-tenant data in a job input is always a bug worth failing on;
 *   - balances/entries in OTHER currencies are filtered (multi-currency orgs
 *     are normal; the job reconciles one currency at a time);
 *   - duplicate receivable rows are rejected (LEDGER_RECON_DUPLICATE_RECEIVABLE) —
 *     they would double-count the sub-ledger side.
 */
export const runReconciliationJob = (
  job: DailyReconciliationJobSpec,
  inputs: ReconciliationJobInputs,
  clock: Clock,
): ReconciliationResult => {
  const date = assertRunDate(job.runDate);
  if (typeof job.orgId !== 'string' || !job.orgId.trim()) {
    throw new DomainError('LEDGER_ORG_REQUIRED', 'a reconciliation job requires a non-blank orgId');
  }
  assertEntryId(job.jobId, 'jobId');

  // --- sub-ledger side -----------------------------------------------------
  const seenReceivables = new Set<string>();
  let subLedgerBalanceMinor = 0n;
  let openReceivableCount = 0;
  for (const row of inputs.openReceivableBalances) {
    if (row.orgId !== job.orgId) {
      throw new DomainError(
        'LEDGER_RECON_SCOPE_MISMATCH',
        `receivable ${String(row.receivableId)} belongs to org '${String(row.orgId)}', but the job runs for '${job.orgId}'`,
        { receivableId: String(row.receivableId), rowOrgId: String(row.orgId), jobOrgId: job.orgId },
      );
    }
    if (row.currency !== job.currency) continue; // other currencies are another run's scope
    assertEntryId(row.receivableId, 'receivableId');
    if (seenReceivables.has(row.receivableId)) {
      throw new DomainError(
        'LEDGER_RECON_DUPLICATE_RECEIVABLE',
        `receivable ${row.receivableId} appears twice in the open-balance snapshot — it would be double-counted`,
        { receivableId: row.receivableId },
      );
    }
    seenReceivables.add(row.receivableId);
    subLedgerBalanceMinor += balanceMinorOf(
      row.balanceMinor,
      'LEDGER_RECON_BALANCE_INVALID',
      'balanceMinor',
    );
    openReceivableCount += 1;
  }

  // --- GL side (derived from the posted entries) ----------------------------
  const entriesInScope = inputs.postedEntries.filter((entry) => {
    if (entry.orgId !== job.orgId) {
      throw new DomainError(
        'LEDGER_RECON_SCOPE_MISMATCH',
        `journal entry ${entry.entryId} belongs to org '${entry.orgId}', but the job runs for '${job.orgId}'`,
        { entryId: entry.entryId, entryOrgId: entry.orgId, jobOrgId: job.orgId },
      );
    }
    // Entries are single-currency by construction; require EVERY line to be in
    // scope so a hand-built mixed-currency entry can never pollute the math.
    return entry.lines.every((line: JournalLine) => line.currency === job.currency);
  });
  const glBalanceMinor = arControlBalanceMinor(entriesInScope);

  const driftMinor = subLedgerBalanceMinor - glBalanceMinor;
  const common: ReconciliationCommon = {
    job: { ...job, runDate: date },
    subLedgerBalanceMinor,
    glBalanceMinor,
    driftMinor,
    openReceivableCount,
    postedEntryCount: entriesInScope.length,
  };

  if (driftMinor !== 0n) {
    return {
      ...common,
      outcome: 'drift',
      event: reconciliationDriftDetectedEvent(
        {
          jobId: job.jobId,
          runDate: date,
          orgId: job.orgId,
          currency: job.currency,
          subLedgerBalanceMinor: minorUnits(subLedgerBalanceMinor),
          glBalanceMinor: minorUnits(glBalanceMinor),
          driftMinor: minorUnits(driftMinor),
          openReceivableCount,
          postedEntryCount: entriesInScope.length,
        },
        clock,
      ),
    };
  }
  return {
    ...common,
    outcome: 'ok',
    event: reconciliationMatchedEvent(
      {
        jobId: job.jobId,
        runDate: date,
        orgId: job.orgId,
        currency: job.currency,
        balanceMinor: minorUnits(glBalanceMinor),
        openReceivableCount,
        postedEntryCount: entriesInScope.length,
      },
      clock,
    ),
  };
};

import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  entryPostedEvent,
  entryReversedEvent,
  minorUnits,
  reconciliationDriftDetectedEvent,
  reconciliationMatchedEvent,
} from './events';
import { post, reverseEntry } from './journal';
import type { MoneyMovementEvent } from './events';

const clock: Clock = { now: () => new Date('2025-09-02T08:00:00.000Z') };
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const movement = (overrides: Partial<MoneyMovementEvent> = {}): MoneyMovementEvent => ({
  name: 'invoicing.invoiceIssued',
  sourceEventId: uid('a00000000001'),
  orgId: 'org-1',
  occurredAt: '2025-09-01T10:00:00.000Z',
  amountMinor: 125_000,
  currency: 'KES',
  reference: 'INV-0001',
  actor: 'invoicing-service',
  ...overrides,
});

describe('ledger.* events follow the repo envelope style', () => {
  it('ledger.entryPosted — narrow serializable payload, version 1, Clock-derived occurredAt', () => {
    const { entry, events } = post(movement(), [], clock);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('ledger.entryPosted');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(entry.entryId);
    expect(event.occurredAt).toBe('2025-09-02T08:00:00.000Z');
    if (event.name !== 'ledger.entryPosted') throw new Error(`unexpected event ${event.name}`);
    expect(event.payload).toEqual({
      entryId: entry.entryId,
      orgId: 'org-1',
      sourceEventName: 'invoicing.invoiceIssued',
      sourceEventId: uid('a00000000001'),
      amountMinor: 125_000, // safe-integer NUMBER on the wire, not bigint
      currency: 'KES',
      status: 'POSTED',
      reversalOf: null,
    });
    expect(typeof event.payload.amountMinor).toBe('number');
  });

  it('ledger.entryPosted marks correcting entries with reversalOf', () => {
    const { entry } = post(movement(), [], clock);
    const { reversal, events } = reverseEntry(entry, { reason: 'voided', actor: 'ops' }, clock);
    const posted = entryPostedEvent(
      {
        entryId: reversal.entryId,
        orgId: reversal.orgId,
        sourceEventName: reversal.sourceEventName,
        sourceEventId: reversal.sourceEventId,
        amountMinor: reversal.lines[0]!.amountMinor,
        currency: reversal.lines[0]!.currency,
        status: reversal.status,
        reversalOf: reversal.reversalOf,
      },
      clock,
    );
    expect(posted.payload.reversalOf).toBe(entry.entryId);
    expect(events.map((e) => e.name)).toEqual(['ledger.entryPosted', 'ledger.entryReversed']);
  });

  it('ledger.entryReversed — aggregateId is the ORIGINAL entry', () => {
    const { entry } = post(movement(), [], clock);
    const event = entryReversedEvent(
      { entryId: entry.entryId, reversalEntryId: uid('c00000000001'), reason: 'misposted', actor: 'ops-admin' },
      clock,
    );
    expect(event.name).toBe('ledger.entryReversed');
    expect(event.aggregateId).toBe(entry.entryId);
    expect(event.payload).toEqual({
      entryId: entry.entryId,
      reversalEntryId: uid('c00000000001'),
      reason: 'misposted',
      actor: 'ops-admin',
      reversedAt: '2025-09-02T08:00:00.000Z',
    });
  });

  it('reconciliation events carry the job id as aggregateId and the run date', () => {
    const driftPayload = {
      jobId: uid('d00000000001'),
      runDate: '2025-09-01',
      orgId: 'org-1',
      currency: 'KES',
      subLedgerBalanceMinor: 240_000,
      glBalanceMinor: 250_000,
      driftMinor: -10_000,
      openReceivableCount: 2,
      postedEntryCount: 3,
    };
    const drift = reconciliationDriftDetectedEvent(driftPayload, clock);
    expect(drift.name).toBe('ledger.reconciliationDriftDetected');
    expect(drift.aggregateId).toBe(uid('d00000000001'));
    expect(drift.payload).toEqual(driftPayload);

    const matched = reconciliationMatchedEvent(
      {
        jobId: uid('d00000000002'),
        runDate: '2025-09-01',
        orgId: 'org-1',
        currency: 'KES',
        balanceMinor: 250_000,
        openReceivableCount: 2,
        postedEntryCount: 3,
      },
      clock,
    );
    expect(matched.name).toBe('ledger.reconciliationMatched');
    expect(matched.payload.balanceMinor).toBe(250_000);
  });

  it('minorUnits converts bigint → safe number and refuses precision loss (no floats on the wire)', () => {
    expect(minorUnits(125_000n)).toBe(125_000);
    expect(minorUnits(42)).toBe(42);
    expect(() => minorUnits(2 ** 53)).toThrow(DomainError);
    try {
      minorUnits(2 ** 53);
    } catch (err) {
      expect((err as DomainError).code).toBe('LEDGER_AMOUNT_NOT_SAFE_INTEGER');
    }
    expect(() => minorUnits(1.5)).toThrow(DomainError);
    expect(() => minorUnits(-(2 ** 53))).toThrow(DomainError);
  });
});

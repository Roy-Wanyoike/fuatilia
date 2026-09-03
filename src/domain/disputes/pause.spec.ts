import { describe, expect, it } from 'vitest';
import { type Clock, type Uuid, uuid } from '../shared';
import { openDispute, transitionDispute, type Dispute, type DisputeStatus } from './dispute';
import {
  automatedCollectionAllowed,
  collectionsHoldFor,
  isDisputeOpen,
  toDisputeFacts,
  type DisputeFacts,
} from './pause';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(301);
const RECEIVABLE = uid(401);

const T0 = '2026-03-02T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

/** Drive a real dispute to `status` through legal transitions only. */
const disputeAt = (status: DisputeStatus, receivableId: Uuid = RECEIVABLE): Dispute => {
  const { dispute } = openDispute(
    {
      id: uid(760),
      orgId: ORG,
      receivableId,
      category: 'quantity',
      description: 'customer was billed for 12 units, delivered 10',
      openedBy: 'agent-7',
      sequenceNo: 1,
    },
    [],
    at(T0),
  );
  const path: DisputeStatus[] = [];
  if (status === 'investigating') path.push('investigating');
  if (status === 'awaiting_customer') path.push('investigating', 'awaiting_customer');
  if (status === 'awaiting_business') path.push('investigating', 'awaiting_business');
  if (status === 'resolved' || status === 'rejected') path.push('investigating', status);
  if (status === 'cancelled') path.push('cancelled');
  let current = dispute;
  path.forEach((to, i) => {
    current = transitionDispute(
      current,
      to,
      { reason: `step ${i} to ${to}`, actorId: 'agent-7' },
      at(`2026-03-02T0${9}:0${i + 5}:00.000Z`),
    ).dispute;
  });
  return current;
};

// --- the hold set ---------------------------------------------------------------

describe('isDisputeOpen — which states hold collections', () => {
  it('classifies every dispute status (table)', () => {
    const table: Array<[DisputeStatus, boolean]> = [
      ['opened', true],
      ['investigating', true],
      ['awaiting_customer', true],
      ['awaiting_business', true],
      ['resolved', false],
      ['rejected', false],
      ['cancelled', false],
    ];
    for (const [status, open] of table) {
      expect(isDisputeOpen(status)).toBe(open);
    }
  });
});

// --- collectionsHoldFor ------------------------------------------------------------

describe('collectionsHoldFor — the receivable-level hold flag (plain data in, plain data out)', () => {
  it('is false when the receivable carries no dispute states', () => {
    expect(collectionsHoldFor([])).toBe(false);
  });

  it('is true for each open dispute state, alone or combined (table)', () => {
    const table: Array<[readonly DisputeStatus[], boolean]> = [
      [['opened'], true],
      [['investigating'], true],
      [['awaiting_customer'], true],
      [['awaiting_business'], true],
      [['investigating', 'awaiting_customer'], true],
      [['resolved'], false],
      [['rejected'], false],
      [['cancelled'], false],
      [['resolved', 'rejected', 'cancelled'], false],
      [['resolved', 'awaiting_business'], true], // one live dispute is enough
    ];
    for (const [states, hold] of table) {
      expect(collectionsHoldFor(states)).toBe(hold);
    }
  });
});

// --- automatedCollectionAllowed -----------------------------------------------------

describe('automatedCollectionAllowed — the policy gate (any open dispute ⇒ false)', () => {
  const facts = (...rows: Array<[Uuid, DisputeStatus]>): DisputeFacts[] =>
    rows.map(([receivableId, status], i) => ({ disputeId: uid(900 + i), receivableId, status }));

  it('allows automation when the receivable has no dispute facts', () => {
    expect(automatedCollectionAllowed([])).toBe(true);
  });

  it('blocks automation while any open dispute is on the receivable (table)', () => {
    const table: Array<[DisputeStatus, boolean]> = [
      ['opened', false],
      ['investigating', false],
      ['awaiting_customer', false],
      ['awaiting_business', false],
      ['resolved', true],
      ['rejected', true],
      ['cancelled', true],
    ];
    for (const [status, allowed] of table) {
      expect(automatedCollectionAllowed(facts([RECEIVABLE, status]))).toBe(allowed);
    }
  });

  it('evaluates per receivable — the caller filters the facts for the one being dun-ed', () => {
    const OTHER = uid(402);
    const world = facts(
      [RECEIVABLE, 'investigating'],
      [OTHER, 'resolved'], // other receivable's closed dispute is irrelevant...
      [OTHER, 'cancelled'],
    );
    expect(automatedCollectionAllowed(world.filter((f) => f.receivableId === OTHER))).toBe(true);
    expect(automatedCollectionAllowed(world.filter((f) => f.receivableId === RECEIVABLE))).toBe(
      false,
    );
  });
});

// --- the core product rule, end to end ------------------------------------------------

describe('the pause → resume rule over the real lifecycle (SPEC §29)', () => {
  it('holds from the moment a dispute opens, releases on every terminal outcome (table)', () => {
    for (const terminal of ['resolved', 'rejected', 'cancelled'] as const) {
      const dispute = disputeAt('opened');
      // pause fact: dispute.opened → hold, from the very first state
      expect(automatedCollectionAllowed([toDisputeFacts(dispute)])).toBe(false);
      expect(collectionsHoldFor([dispute.status])).toBe(true);

      // waiting states never release the hold
      let current = transitionDispute(
        dispute,
        'investigating',
        { reason: 'investigation picked up', actorId: 'agent-7' },
        at('2026-03-02T09:00:00.000Z'),
      ).dispute;
      current = transitionDispute(
        current,
        'awaiting_customer',
        { reason: 'proof of delivery requested', actorId: 'agent-7' },
        at('2026-03-02T09:30:00.000Z'),
      ).dispute;
      expect(automatedCollectionAllowed([toDisputeFacts(current)])).toBe(false);

      // the terminal transition is the resume fact
      current = transitionDispute(
        current,
        'investigating',
        { reason: 'proof received', actorId: 'agent-7' },
        at('2026-03-02T10:00:00.000Z'),
      ).dispute;
      const resumeReason =
        terminal === 'resolved'
          ? 'short delivery confirmed — credit note issued'
          : terminal === 'rejected'
            ? 'full quantity signed for on the delivery note'
            : 'customer withdrew the claim';
      const closeArgs =
        terminal === 'resolved'
          ? { reason: resumeReason, actorId: 'agent-7', outcome: { remedy: 'none' } as const }
          : { reason: resumeReason, actorId: 'agent-7' };
      current = transitionDispute(current, terminal, closeArgs, at('2026-03-02T11:00:00.000Z'))
        .dispute;
      expect(current.status).toBe(terminal);
      expect(isDisputeOpen(current.status)).toBe(false);
      expect(automatedCollectionAllowed([toDisputeFacts(current)])).toBe(true);
      expect(collectionsHoldFor([current.status])).toBe(false);
    }
  });

  it('toDisputeFacts projects exactly the pause-relevant columns', () => {
    const dispute = disputeAt('awaiting_business');
    expect(toDisputeFacts(dispute)).toEqual({
      disputeId: dispute.id,
      receivableId: RECEIVABLE,
      status: 'awaiting_business',
    });
  });
});

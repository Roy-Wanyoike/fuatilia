import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  DISPUTE_CATEGORIES,
  DISPUTE_TRANSITIONS,
  NO_REMEDY,
  formatDisputeNumber,
  openDispute,
  transitionDispute,
  type Dispute,
  type DisputeStatus,
  type DisputeTransition,
} from './dispute';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(301);
const ORG_B = uid(302);
const RECEIVABLE = uid(401);
const OTHER_RECEIVABLE = uid(402);
const CREDIT_NOTE = uid(501);
const WRITE_OFF = uid(502);
const ASSIGNEE = uid(601);

const T0 = '2026-03-02T08:00:00.000Z';
const T1 = '2026-03-02T09:00:00.000Z';
const T2 = '2026-03-02T10:00:00.000Z';
const T3 = '2026-03-02T11:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock0 = at(T0);
const clock1 = at(T1);
const clock2 = at(T2);
const clock3 = at(T3);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

/** Open a fresh dispute on `receivableId` with sequence `seq`. */
const open = (
  seq: number,
  receivableId: Uuid = RECEIVABLE,
  orgId: Uuid = ORG,
  clock: Clock = clock0,
  overrides: Partial<Parameters<typeof openDispute>[0]> = {},
): { dispute: Dispute; event: ReturnType<typeof openDispute>['event'] } =>
  openDispute(
    {
      id: uid(700 + seq),
      orgId,
      receivableId,
      category: 'quantity',
      description: 'customer was billed for 12 units, delivered 10',
      openedBy: 'agent-7',
      sequenceNo: seq,
      ...overrides,
    },
    [],
    clock,
  );

const ALL_STATUSES = Object.keys(DISPUTE_TRANSITIONS) as DisputeStatus[];

/** Drive a real dispute to `status` through legal transitions only. */
const disputeAt = (status: DisputeStatus, receivableId: Uuid = RECEIVABLE): Dispute => {
  const { dispute } = open(1, receivableId);
  const path: DisputeStatus[] = [];
  if (status === 'investigating') path.push('investigating');
  if (status === 'awaiting_customer') path.push('investigating', 'awaiting_customer');
  if (status === 'awaiting_business') path.push('investigating', 'awaiting_business');
  if (status === 'resolved' || status === 'rejected') path.push('investigating', status);
  if (status === 'cancelled') path.push('cancelled');
  let current = dispute;
  path.forEach((to, i) => {
    const stepped = transitionDispute(
      current,
      to,
      { reason: `step ${i} to ${to}`, actorId: 'agent-7' },
      at(`2026-03-02T0${9}:0${i}:00.000Z`),
    );
    current = stepped.dispute;
  });
  return current;
};

const expectedEventName = (to: DisputeStatus): string =>
  to === 'resolved'
    ? 'dispute.resolved'
    : to === 'rejected'
      ? 'dispute.rejected'
      : to === 'cancelled'
        ? 'dispute.cancelled'
        : 'dispute.statusChanged';

// --- openDispute ---------------------------------------------------------------

describe('openDispute — opening emits the typed pause fact', () => {
  it('opens with the per-org number, openedAt from the Clock, and a dispute.opened event', () => {
    const { dispute, event } = open(14);
    expect(dispute).toEqual({
      id: uid(714),
      disputeNumber: 'DSP-000014',
      sequence: 14,
      orgId: ORG,
      receivableId: RECEIVABLE,
      category: 'quantity',
      description: 'customer was billed for 12 units, delivered 10',
      evidenceRefs: [],
      assignedTo: null,
      openedAt: new Date(T0),
      openedBy: 'agent-7',
      status: 'opened',
      outcome: null,
      closedAt: null,
      closedBy: null,
      history: [],
    });
    expect(event.name).toBe('dispute.opened');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(dispute.id);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toEqual({
      disputeId: dispute.id,
      disputeNumber: 'DSP-000014',
      orgId: ORG,
      receivableId: RECEIVABLE,
      category: 'quantity',
      description: 'customer was billed for 12 units, delivered 10',
      evidenceRefs: [],
      assignedTo: null,
      openedBy: 'agent-7',
      openedAt: T0,
    });
  });

  it('accepts every SPEC §29 category (table)', () => {
    for (const category of DISPUTE_CATEGORIES) {
      const { dispute } = open(1, RECEIVABLE, ORG, clock0, { category });
      expect(dispute.category).toBe(category);
    }
  });

  it('carries opaque evidence refs and an assigned user when given', () => {
    const { dispute, event } = open(1, RECEIVABLE, ORG, clock0, {
      evidenceRefs: ['evidence://pod-2214.jpg', 'msg://wa-99881'],
      assignedTo: ASSIGNEE,
    });
    expect(dispute.evidenceRefs).toEqual(['evidence://pod-2214.jpg', 'msg://wa-99881']);
    expect(dispute.assignedTo).toBe(ASSIGNEE);
    expect(event.payload.evidenceRefs).toEqual(dispute.evidenceRefs);
    expect(event.payload.assignedTo).toBe(ASSIGNEE);
  });

  it('formats disputeNumber through the injectable formatter', () => {
    const { dispute } = open(3, RECEIVABLE, ORG, clock0, {
      formatNumber: (seq) => `DSP-${ORG.slice(0, 4)}-${String(seq).padStart(4, '0')}`,
    });
    expect(dispute.disputeNumber).toBe(`DSP-${ORG.slice(0, 4)}-0003`);
  });

  it('never mutates the registry array it is given', () => {
    const registry: Dispute[] = [];
    openDispute(
      {
        id: uid(715),
        orgId: ORG,
        receivableId: RECEIVABLE,
        category: 'pricing',
        description: 'quoted price differs from the PO',
        openedBy: 'agent-7',
        sequenceNo: 1,
      },
      registry,
      clock0,
    );
    expect(registry).toHaveLength(0); // caller appends; fn is pure
  });
});

describe('openDispute — input validation (stable codes)', () => {
  it('rejects unknown categories', () => {
    expectCode(() => open(1, RECEIVABLE, ORG, clock0, { category: 'shipping' }), 'DISPUTE_CATEGORY_INVALID');
    expectCode(() => open(1, RECEIVABLE, ORG, clock0, { category: '' }), 'DISPUTE_CATEGORY_INVALID');
  });

  it('requires a description and an actor', () => {
    expectCode(
      () => open(1, RECEIVABLE, ORG, clock0, { description: '   ' }),
      'DISPUTE_DESCRIPTION_REQUIRED',
    );
    expectCode(() => open(1, RECEIVABLE, ORG, clock0, { openedBy: ' ' }), 'DISPUTE_ACTOR_REQUIRED');
  });

  it('rejects blank evidence references', () => {
    expectCode(
      () => open(1, RECEIVABLE, ORG, clock0, { evidenceRefs: ['ok-ref', '   '] }),
      'DISPUTE_EVIDENCE_INVALID',
    );
  });

  it('rejects a broken clock', () => {
    expectCode(
      () => open(1, RECEIVABLE, ORG, { now: () => new Date('not-a-date') }),
      'DISPUTE_CLOCK_INVALID',
    );
  });

  it('rejects malformed sequences (table)', () => {
    const table: Array<[number, string]> = [
      [0, 'DISPUTE_SEQUENCE_INVALID'],
      [-3, 'DISPUTE_SEQUENCE_INVALID'],
      [1.5, 'DISPUTE_SEQUENCE_INVALID'],
      [Number.NaN, 'DISPUTE_SEQUENCE_INVALID'],
      [Number.POSITIVE_INFINITY, 'DISPUTE_SEQUENCE_INVALID'],
    ];
    for (const [sequenceNo, code] of table) {
      expectCode(
        () =>
          openDispute(
            {
              id: uid(716),
              orgId: ORG,
              receivableId: RECEIVABLE,
              category: 'quantity',
              description: 'sequence shape check',
              openedBy: 'agent-7',
              sequenceNo,
            },
            [],
            clock0,
          ),
        code,
      );
    }
  });

  it('rejects a blank formatter result', () => {
    expectCode(
      () => open(1, RECEIVABLE, ORG, clock0, { formatNumber: () => '  ' }),
      'DISPUTE_NUMBER_INVALID',
    );
  });
});

describe('openDispute — the per-org controlled sequence', () => {
  it('advances strictly within an org: repeats and regressions are refused', () => {
    const registry: Dispute[] = [];
    for (const seq of [1, 2, 3]) {
      const { dispute } = openDispute(
        {
          id: uid(800 + seq),
          orgId: ORG,
          receivableId: uid(900 + seq),
          category: 'pricing',
          description: 'price does not match the quoted PO',
          openedBy: 'agent-7',
          sequenceNo: seq,
        },
        registry,
        clock0,
      );
      registry.push(dispute);
    }
    expect(registry.map((d) => d.disputeNumber)).toEqual([
      'DSP-000001',
      'DSP-000002',
      'DSP-000003',
    ]);
    const table: Array<[number, string]> = [
      [1, 'DISPUTE_SEQUENCE_OUT_OF_ORDER'],
      [3, 'DISPUTE_SEQUENCE_OUT_OF_ORDER'],
      [0, 'DISPUTE_SEQUENCE_INVALID'],
    ];
    for (const [sequenceNo, code] of table) {
      expectCode(
        () =>
          openDispute(
            {
              id: uid(890),
              orgId: ORG,
              receivableId: OTHER_RECEIVABLE,
              category: 'pricing',
              description: 'another challenge',
              openedBy: 'agent-7',
              sequenceNo,
            },
            registry,
            clock1,
          ),
        code,
      );
    }
  });

  it('sequences are independent per org (same number valid in another org)', () => {
    const { dispute: inA } = open(1, RECEIVABLE, ORG, clock0);
    const { dispute: inB } = open(1, OTHER_RECEIVABLE, ORG_B, clock0);
    expect(inA.disputeNumber).toBe('DSP-000001');
    expect(inB.disputeNumber).toBe('DSP-000001'); // same shape, different org — legal
  });

  it('disputeNumber must be unique within the org (custom formatters can collide)', () => {
    const { dispute: first } = open(1, RECEIVABLE, ORG, clock0, {
      formatNumber: () => 'DSP-CHALLENGE',
    });
    expect(first.disputeNumber).toBe('DSP-CHALLENGE');
    expectCode(
      () =>
        openDispute(
          {
            id: uid(810),
            orgId: ORG,
            receivableId: OTHER_RECEIVABLE,
            category: 'other',
            description: 'dupe number attempt',
            openedBy: 'agent-7',
            sequenceNo: 2, // newer sequence, but formatter re-uses the number
            formatNumber: () => 'DSP-CHALLENGE',
          },
          [first],
          clock1,
        ),
      'DISPUTE_NUMBER_TAKEN',
    );
  });

  it('refuses a dispute id that is already registered (audit-trail protection)', () => {
    const { dispute } = open(1);
    expectCode(
      () =>
        openDispute(
          {
            id: dispute.id,
            orgId: ORG,
            receivableId: OTHER_RECEIVABLE,
            category: 'other',
            description: 'id collision attempt',
            openedBy: 'agent-7',
            sequenceNo: 2,
          },
          [dispute],
          clock1,
        ),
      'DISPUTE_ID_TAKEN',
    );
  });
});

describe('openDispute — one open dispute per receivable', () => {
  it('rejects a second open dispute on the same receivable, from every open status (table)', () => {
    const table: DisputeStatus[] = ['opened', 'investigating', 'awaiting_customer', 'awaiting_business'];
    for (const status of table) {
      const existing = disputeAt(status);
      expectCode(
        () =>
          openDispute(
            {
              id: uid(850),
              orgId: ORG,
              receivableId: RECEIVABLE,
              category: 'duplicate',
              description: 'duplicate-billing challenge while another is open',
              openedBy: 'agent-7',
              sequenceNo: 9,
            },
            [existing],
            clock2,
          ),
        'DISPUTE_ALREADY_OPEN',
      );
    }
  });

  it('a dispute on another receivable, org or a closed dispute never blocks opening', () => {
    const openElsewhere = disputeAt('investigating', OTHER_RECEIVABLE);
    const closed = disputeAt('resolved');
    const { dispute } = openDispute(
      {
        id: uid(851),
        orgId: ORG,
        receivableId: RECEIVABLE,
        category: 'quality',
        description: 'previous dispute resolved; new quality challenge',
        openedBy: 'agent-7',
        sequenceNo: 2,
      },
      [openElsewhere, closed],
      clock2,
    );
    expect(dispute.status).toBe('opened');
  });

  it('allows re-opening after every terminal status (table)', () => {
    for (const terminal of ['resolved', 'rejected', 'cancelled'] as const) {
      const closed = disputeAt(terminal);
      const { dispute } = openDispute(
        {
          id: uid(860),
          orgId: ORG,
          receivableId: RECEIVABLE,
          category: 'quantity',
          description: `re-opened after ${terminal}`,
          openedBy: 'agent-7',
          sequenceNo: 5,
        },
        [closed],
        clock2,
      );
      expect(dispute.status).toBe('opened');
    }
  });
});

// --- transitionDispute -----------------------------------------------------------

describe('transitionDispute — the full legal/illegal transition grid (7×7)', () => {
  // The table IS DISPUTE_TRANSITIONS; this test walks the complete grid so a
  // docs/03 drift in either direction (missing legal, sneaky illegal) fails.
  it('accepts exactly the table rows, with the right event, history and close stamps', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const legal = DISPUTE_TRANSITIONS[from].includes(to);
        const source = disputeAt(from);
        const sourceHistoryLen = source.history.length;
        if (!legal) {
          expectCode(
            () =>
              transitionDispute(
                source,
                to,
                { reason: `should be illegal ${from}→${to}`, actorId: 'agent-7' },
                clock1,
              ),
            'DISPUTE_TRANSITION_INVALID',
          );
          continue;
        }
        const { dispute: next, event } = transitionDispute(
          source,
          to,
          { reason: `${from} → ${to}`, actorId: 'agent-7' },
          clock1,
        );
        // event contract
        expect(event.name).toBe(expectedEventName(to));
        expect(event.aggregateId).toBe(source.id);
        expect(event.occurredAt).toBe(T1);
        if (event.name === 'dispute.statusChanged') {
          expect(event.payload).toEqual({
            disputeId: source.id,
            receivableId: source.receivableId,
            from,
            to,
            reason: `${from} → ${to}`,
            actorId: 'agent-7',
          });
        }
        // append-only history
        expect(next.status).toBe(to);
        expect(next.history).toHaveLength(source.history.length + 1);
        const last: DisputeTransition | undefined = next.history[next.history.length - 1];
        expect(last).toEqual({ from, to, reason: `${from} → ${to}`, actorId: 'agent-7', at: new Date(T1) });
        // terminal stamps
        if (DISPUTE_TRANSITIONS[to].length === 0) {
          expect(next.closedAt).toEqual(new Date(T1));
          expect(next.closedBy).toBe('agent-7');
        } else {
          expect(next.closedAt).toBeNull();
          expect(next.closedBy).toBeNull();
        }
        // original untouched (purity)
        expect(source.status).toBe(from);
        expect(source.history).toHaveLength(sourceHistoryLen);
      }
    }
  });

  it('the terminal states are terminal — nothing re-opens them', () => {
    for (const terminal of ['resolved', 'rejected', 'cancelled'] as const) {
      for (const to of ALL_STATUSES) {
        expectCode(
          () =>
            transitionDispute(
              disputeAt(terminal),
              to,
              { reason: 'resurrection attempt', actorId: 'agent-7' },
              clock1,
            ),
          'DISPUTE_TRANSITION_INVALID',
        );
      }
    }
  });

  it('rejects an unknown target status', () => {
    expectCode(
      () =>
        transitionDispute(
          disputeAt('opened'),
          'frozen' as never,
          { reason: 'typo', actorId: 'agent-7' },
          clock1,
        ),
      'DISPUTE_STATUS_INVALID',
    );
  });
});

describe('transitionDispute — every decision is recorded (reason + actor)', () => {
  it('requires a reason and an actor on every legal transition (table)', () => {
    for (const from of ALL_STATUSES) {
      for (const to of DISPUTE_TRANSITIONS[from]) {
        const source = disputeAt(from);
        expectCode(
          () => transitionDispute(source, to, { reason: '  ', actorId: 'agent-7' }, clock1),
          'DISPUTE_REASON_REQUIRED',
        );
        expectCode(
          () => transitionDispute(source, to, { reason: 'why', actorId: ' ' }, clock1),
          'DISPUTE_ACTOR_REQUIRED',
        );
      }
    }
  });

  it('rejects a broken clock on transition', () => {
    expectCode(
      () =>
        transitionDispute(
          disputeAt('opened'),
          'investigating',
          { reason: 'why', actorId: 'agent-7' },
          { now: () => new Date('nope') },
        ),
      'DISPUTE_CLOCK_INVALID',
    );
  });
});

describe('transitionDispute — resolution carries the outcome decision', () => {
  it('defaults to no remedy when resolved without an outcome', () => {
    const { dispute, event } = transitionDispute(
      disputeAt('investigating'),
      'resolved',
      { reason: 'goods delivered as invoiced after re-count', actorId: 'agent-7' },
      clock2,
    );
    expect(dispute.outcome).toEqual(NO_REMEDY);
    expect(event.name).toBe('dispute.resolved');
    expect(event.payload).toEqual({
      disputeId: dispute.id,
      receivableId: dispute.receivableId,
      reason: 'goods delivered as invoiced after re-count',
      actorId: 'agent-7',
      outcome: NO_REMEDY,
      resolvedAt: T2,
    });
  });

  it('resolves with a credit-note remedy reference (opaque Uuid)', () => {
    const { dispute, event } = transitionDispute(
      disputeAt('investigating'),
      'resolved',
      {
        reason: 'overcharge confirmed — credit note issued',
        actorId: 'finance-2',
        outcome: { remedy: 'credit_note', creditNoteId: CREDIT_NOTE },
      },
      clock2,
    );
    expect(dispute.outcome).toEqual({ remedy: 'credit_note', creditNoteId: CREDIT_NOTE });
    if (event.name === 'dispute.resolved') {
      expect(event.payload.outcome).toEqual({ remedy: 'credit_note', creditNoteId: CREDIT_NOTE });
    } else {
      throw new Error('expected dispute.resolved');
    }
  });

  it('resolves with a write-off remedy reference (opaque Uuid)', () => {
    const { dispute } = transitionDispute(
      disputeAt('investigating'),
      'resolved',
      {
        reason: 'customer goodwill — balance written off',
        actorId: 'finance-2',
        outcome: { remedy: 'write_off', writeOffId: WRITE_OFF },
      },
      clock2,
    );
    expect(dispute.outcome).toEqual({ remedy: 'write_off', writeOffId: WRITE_OFF });
  });

  it('rejects malformed outcome decisions (table)', () => {
    const source = disputeAt('investigating');
    const table: Array<[Parameters<typeof transitionDispute>[2]['outcome'], string]> = [
      [{ remedy: 'credit_note' } as never, 'DISPUTE_OUTCOME_INVALID'],
      [{ remedy: 'write_off' } as never, 'DISPUTE_OUTCOME_INVALID'],
      [{ remedy: 'discount' } as never, 'DISPUTE_OUTCOME_INVALID'],
    ];
    for (const [outcome, code] of table) {
      expectCode(
        () =>
          transitionDispute(
            source,
            'resolved',
            { reason: 'bad outcome attempt', actorId: 'agent-7', outcome },
            clock2,
          ),
        code,
      );
    }
  });

  it('reject and cancel emit their own resume facts with reason + actor', () => {
    const rejected = transitionDispute(
      disputeAt('investigating'),
      'rejected',
      { reason: 'delivery note signed for the full quantity', actorId: 'agent-7' },
      clock2,
    );
    expect(rejected.event.name).toBe('dispute.rejected');
    if (rejected.event.name === 'dispute.rejected') {
      expect(rejected.event.payload).toEqual({
        disputeId: rejected.dispute.id,
        receivableId: rejected.dispute.receivableId,
        reason: 'delivery note signed for the full quantity',
        actorId: 'agent-7',
        rejectedAt: T2,
      });
    }
    expect(rejected.dispute.outcome).toBeNull();

    const cancelled = transitionDispute(
      disputeAt('awaiting_business'),
      'cancelled',
      { reason: 'customer withdrew the claim', actorId: 'agent-7' },
      clock3,
    );
    expect(cancelled.event.name).toBe('dispute.cancelled');
    if (cancelled.event.name === 'dispute.cancelled') {
      expect(cancelled.event.payload.cancelledAt).toBe(T3);
      expect(cancelled.event.payload.reason).toBe('customer withdrew the claim');
    } else {
      throw new Error('expected dispute.cancelled');
    }
  });
});

// --- misc contract -----------------------------------------------------------------

describe('dispute lane contract', () => {
  it('uses the repo disputeNumber format by default', () => {
    expect(formatDisputeNumber(1)).toBe('DSP-000001');
    expect(formatDisputeNumber(123456)).toBe('DSP-123456');
  });

  it('keeps the full history append-only through a long legal walk', () => {
    let current = disputeAt('awaiting_business');
    const steps: DisputeStatus[] = ['investigating', 'awaiting_customer', 'investigating', 'resolved'];
    steps.forEach((to, i) => {
      const stepped = transitionDispute(
        current,
        to,
        { reason: `walk step ${i}`, actorId: 'agent-7' },
        at(`2026-03-02T1${i}:30:00.000Z`),
      );
      current = stepped.dispute;
    });
    // opened → investigating → awaiting_business (fixture) + 4 walked steps
    expect(current.history.map((h) => h.to)).toEqual([
      'investigating',
      'awaiting_business',
      'investigating',
      'awaiting_customer',
      'investigating',
      'resolved',
    ]);
    expect(current.status).toBe('resolved');
    expect(current.closedBy).toBe('agent-7');
  });
});

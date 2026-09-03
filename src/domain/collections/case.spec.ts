import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  CASE_TRANSITIONS,
  formatCaseNumber,
  openCase,
  openCaseCoverageOf,
  escalateCase,
  transitionCase,
  type CollectionsCase,
  type OpenCaseCoverage,
  type CaseStatus,
} from './case';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const ORG_B = uid(902);
const R1 = uid(951);
const R2 = uid(952);
const R3 = uid(953);
const COLLECTOR = uid(971);

const T0 = '2026-04-01T08:00:00.000Z';
const T1 = '2026-04-01T09:00:00.000Z';
const T2 = '2026-04-01T10:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock0 = at(T0);
const clock1 = at(T1);
const clock2 = at(T2);

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

interface OpenOverrides {
  readonly id?: Uuid;
  readonly orgId?: Uuid;
  readonly receivableIds?: readonly Uuid[];
  readonly priority?: string;
  readonly openedBy?: string;
  readonly sequenceNo?: number;
  readonly formatNumber?: (sequenceNo: number) => string;
}

/** Open a fresh case on `receivableIds` with sequence `seq`. */
const open = (
  seq: number,
  coverage: readonly OpenCaseCoverage[] = [],
  clock: Clock = clock0,
  overrides: OpenOverrides = {},
): { case: CollectionsCase; openedEventName: string } => {
  const result = openCase(
    {
      id: overrides.id ?? uid(800 + (Number.isSafeInteger(seq) ? seq : 0)),
      orgId: overrides.orgId ?? ORG,
      receivableIds: overrides.receivableIds ?? [R1],
      collectorId: COLLECTOR,
      priority: overrides.priority,
      openedBy: overrides.openedBy ?? 'agent-7',
      sequenceNo: overrides.sequenceNo ?? seq,
      formatNumber: overrides.formatNumber,
    },
    coverage,
    clock,
  );
  return { case: result.case, openedEventName: result.events[0].name };
};

/** Drive a real case to `status` through legal transitions only. */
const caseAt = (status: CaseStatus, receivableId: Uuid = R1): CollectionsCase => {
  const { case: opened } = open(1, [], clock0, { receivableIds: [receivableId] });
  if (status === 'open') return opened;
  const step1 = transitionCase(
    opened,
    'in_progress',
    { reason: 'agent engaged', actorId: 'agent-7' },
    clock1,
  ).case;
  if (status === 'in_progress') return step1;
  if (status === 'resolved') {
    return transitionCase(
      step1,
      'resolved',
      { reason: 'receivable settled', actorId: 'agent-7' },
      clock2,
    ).case;
  }
  return transitionCase(
    step1,
    'closed_inactive',
    { reason: 'parked by policy', actorId: 'agent-7' },
    clock2,
  ).case;
};

const ALL_STATUSES = Object.keys(CASE_TRANSITIONS) as CaseStatus[];

// --- openCase -------------------------------------------------------------------

describe('openCase — opening emits the R8 coverage fact', () => {
  it('opens with the per-org number, Clock-stamped openedAt and a case.opened event', () => {
    const { case: opened, openedEventName } = open(7);
    expect(openedEventName).toBe('case.opened');
    expect(opened.caseNumber).toBe('CASE-000007');
    expect(opened.status).toBe('open');
    expect(opened.priority).toBe('normal');
    expect(opened.receivableIds).toEqual([R1]);
    expect(opened.openedAt).toEqual(new Date(T0));
    expect(opened.closedAt).toBeNull();
    expect(opened.actions).toEqual([]);
    expect(opened.history).toEqual([]);
    expect(opened.priorityChanges).toEqual([]);
    expect(opened.orgId).toBe(ORG);
    expect(opened.collectorId).toBe(COLLECTOR);
  });

  it('case.opened payload carries the coverage list, collector and audit fields (v1 envelope)', () => {
    const result = openCase(
      {
        id: uid(810),
        orgId: ORG,
        receivableIds: [R1, R2],
        collectorId: COLLECTOR,
        priority: 'urgent',
        openedBy: 'agent-7',
        sequenceNo: 3,
      },
      [],
      clock1,
    );
    const [event] = result.events;
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(uid(810));
    expect(event.occurredAt).toBe(T1);
    expect(event.name).toBe('case.opened');
    expect(event.payload).toEqual({
      caseId: uid(810),
      caseNumber: 'CASE-000003',
      orgId: ORG,
      receivableIds: [R1, R2],
      collectorId: COLLECTOR,
      priority: 'urgent',
      openedBy: 'agent-7',
      openedAt: T1,
    });
  });

  it('supports an injectable caseNumber formatter (org-specific shapes)', () => {
    const { case: opened } = open(12, [], clock0, {
      formatNumber: (seq) => `CLC/2026/${String(seq).padStart(4, '0')}`,
    });
    expect(opened.caseNumber).toBe('CLC/2026/0012');
    expect(formatCaseNumber(1)).toBe('CASE-000001');
  });

  it('a multi-receivable case covers ALL of its receivables (R8 locks each one)', () => {
    const { case: opened } = open(1, [], clock0, { receivableIds: [R1, R2] });
    expect(opened.receivableIds).toEqual([R1, R2]);
    const coverage = openCaseCoverageOf([opened]);
    expect(coverage).toEqual([
      { receivableId: R1, caseId: opened.id },
      { receivableId: R2, caseId: opened.id },
    ]);
  });
});

describe('openCase — input validation table', () => {
  const cases: readonly [string, () => unknown, string][] = [
    ['no receivables', () => open(1, [], clock0, { receivableIds: [] }), 'CASE_RECEIVABLES_REQUIRED'],
    [
      'blank receivable id',
      () => open(1, [], clock0, { receivableIds: ['' as Uuid] }),
      'CASE_RECEIVABLE_INVALID',
    ],
    [
      'duplicate receivable in one case',
      () => open(1, [], clock0, { receivableIds: [R1, R1] }),
      'CASE_RECEIVABLE_DUPLICATE',
    ],
    ['unknown priority', () => open(1, [], clock0, { priority: 'meh' }), 'CASE_PRIORITY_INVALID'],
    ['sequence 0', () => open(0), 'CASE_SEQUENCE_INVALID'],
    ['fractional sequence', () => open(1.5), 'CASE_SEQUENCE_INVALID'],
    [
      'blank formatted number',
      () => open(1, [], clock0, { formatNumber: () => '  ' }),
      'CASE_NUMBER_INVALID',
    ],
    ['blank collector', () =>
      openCase(
        { id: uid(811), orgId: ORG, receivableIds: [R1], collectorId: '  ' as Uuid, openedBy: 'agent-7', sequenceNo: 1 },
        [],
        clock0,
      ), 'CASE_COLLECTOR_REQUIRED'],
    ['blank openedBy', () => open(1, [], clock0, { openedBy: ' ' }), 'CASE_ACTOR_REQUIRED'],
    [
      'broken clock',
      () => open(1, [], { now: () => new Date('nope') }),
      'CASE_CLOCK_INVALID',
    ],
  ];
  it.each(cases)('%s → %s', (_label, fn, code) => expectCode(fn, code));
});

// --- R8 exclusivity ---------------------------------------------------------------

describe('openCase — R8 case exclusivity (the core invariant)', () => {
  it('rejects a new case on a receivable already covered by an OPEN case', () => {
    const { case: first } = open(1);
    const coverage = openCaseCoverageOf([first]);
    expectCode(() => open(2, coverage), 'CASE_ALREADY_OPEN');
    try {
      open(2, coverage);
    } catch (err) {
      const details = (err as DomainError).details as { receivableId: Uuid; caseId: Uuid };
      expect(details.receivableId).toBe(R1);
      expect(details.caseId).toBe(first.id);
    }
  });

  it.each([
    ['the first covered receivable', [R1]],
    ['the second covered receivable', [R2]],
  ])('a case covering A+B blocks a new case on %s', (_label, newReceivables) => {
    const { case: ab } = open(1, [], clock0, { receivableIds: [R1, R2] });
    const coverage = openCaseCoverageOf([ab]);
    expectCode(() => open(2, coverage, clock0, { receivableIds: newReceivables }), 'CASE_ALREADY_OPEN');
  });

  it('a multi-receivable case blocks a new case that would cover BOTH', () => {
    const { case: ab } = open(1, [], clock0, { receivableIds: [R1, R2] });
    const coverage = openCaseCoverageOf([ab]);
    expectCode(
      () => open(2, coverage, clock0, { receivableIds: [R3, R1] }),
      'CASE_ALREADY_OPEN',
    );
  });

  it('uncovered receivables are unaffected — parallel cases coexist on disjoint coverage', () => {
    const { case: onR1 } = open(1, [], clock0, { receivableIds: [R1] });
    const { case: onR3 } = open(2, openCaseCoverageOf([onR1]), clock0, { receivableIds: [R3] });
    expect(onR3.caseNumber).toBe('CASE-000002');
    expect(openCaseCoverageOf([onR1, onR3])).toHaveLength(2);
  });

  it('same receivable in another org is still blocked (receivable ids are globally opaque)', () => {
    const { case: first } = open(1);
    const coverage = openCaseCoverageOf([first]);
    expectCode(
      () => open(1, coverage, clock0, { orgId: ORG_B }),
      'CASE_ALREADY_OPEN',
    );
  });

  it('closing a case RELEASES its receivables — re-open after close succeeds', () => {
    const { case: first } = open(1);
    const blocked = openCaseCoverageOf([first]);
    expectCode(() => open(2, blocked, clock0), 'CASE_ALREADY_OPEN'); // while open, R8 blocks
    const closed = transitionCase(
      transitionCase(first, 'in_progress', { reason: 'engaged', actorId: 'agent-7' }, clock1).case,
      'closed_inactive',
      { reason: 'parked by policy', actorId: 'agent-7' },
      clock2,
    ).case;
    expect(openCaseCoverageOf([closed])).toEqual([]); // the release
    const { case: second } = open(2, openCaseCoverageOf([closed]), clock0, {
      receivableIds: closed.receivableIds,
    });
    expect(second.receivableIds).toEqual([R1]);
  });

  it('a resolved case is no longer coverage-holding either (both terminals release)', () => {
    const resolved = caseAt('resolved');
    expect(openCaseCoverageOf([resolved])).toEqual([]);
  });
});

// --- lifecycle grid -----------------------------------------------------------------

describe('transitionCase — lifecycle grid (table-driven, legal + illegal)', () => {
  const legal = (from: CaseStatus, to: CaseStatus): boolean =>
    CASE_TRANSITIONS[from].includes(to);

  it.each(
    ALL_STATUSES.flatMap((from) =>
      ALL_STATUSES.map((to) => ({ from, to, legal: legal(from, to) })),
    ),
  )('$from → $to (legal=$legal)', ({ from, to, legal: isLegal }) => {
    const target = caseAt(from);
    if (isLegal) {
      const { case: next, events } = transitionCase(
        target,
        to,
        { reason: `step to ${to}`, actorId: 'agent-7' },
        clock2,
      );
      expect(next.status).toBe(to);
      expect(next.history.at(-1)).toMatchObject({ from, to, actorId: 'agent-7' });
      const expectedEvent = to === 'resolved' ? 1 : to === 'closed_inactive' ? 1 : 0;
      expect(events).toHaveLength(expectedEvent);
    } else {
      expectCode(
        () => transitionCase(target, to, { reason: 'x', actorId: 'agent-7' }, clock2),
        'CASE_TRANSITION_INVALID',
      );
    }
  });

  it('unknown target status → CASE_STATUS_INVALID', () => {
    expectCode(
      () =>
        transitionCase(
          caseAt('open'),
          'paused' as CaseStatus,
          { reason: 'x', actorId: 'agent-7' },
          clock1,
        ),
      'CASE_STATUS_INVALID',
    );
  });

  it('engaging (open → in_progress) emits no lane event but appends the history row', () => {
    const opened = caseAt('open');
    const { case: next, events } = transitionCase(
      opened,
      'in_progress',
      { reason: 'agent engaged', actorId: 'agent-7' },
      clock1,
    );
    expect(events).toEqual([]);
    expect(next.history).toEqual([
      { from: 'open', to: 'in_progress', reason: 'agent engaged', actorId: 'agent-7', at: new Date(T1) },
    ]);
    expect(opened.history).toEqual([]); // input untouched (copy-on-write)
  });

  it('resolving emits case.resolved with the covered receivables', () => {
    const inProgress = caseAt('in_progress');
    const { events } = transitionCase(
      inProgress,
      'resolved',
      { reason: 'receivable settled in full', actorId: 'agent-7' },
      clock2,
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('case.resolved');
    expect(event.version).toBe(1);
    expect(event.occurredAt).toBe(T2);
    expect(event.payload).toMatchObject({
      caseId: inProgress.id,
      caseNumber: inProgress.caseNumber,
      orgId: ORG,
      receivableIds: [R1],
      reason: 'receivable settled in full',
      actorId: 'agent-7',
      resolvedAt: T2,
    });
  });

  it('closing emits case.closed whose releasedReceivableIds mark the R8 release', () => {
    const inProgress = caseAt('in_progress', R1);
    const { case: closed, events } = transitionCase(
      inProgress,
      'closed_inactive',
      { reason: 'customer went inactive', actorId: 'agent-7' },
      clock2,
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('case.closed');
    expect(event.payload).toMatchObject({
      caseId: inProgress.id,
      releasedReceivableIds: [R1],
      closedAt: T2,
      actorId: 'agent-7',
    });
    expect(closed.closedAt).toEqual(new Date(T2));
    expect(closed.closedBy).toBe('agent-7');
  });

  it('every transition requires reason + actor (audit-complete by construction)', () => {
    const opened = caseAt('open');
    expectCode(
      () => transitionCase(opened, 'in_progress', { reason: ' ', actorId: 'agent-7' }, clock1),
      'CASE_REASON_REQUIRED',
    );
    expectCode(
      () => transitionCase(opened, 'in_progress', { reason: 'engaged', actorId: ' ' }, clock1),
      'CASE_ACTOR_REQUIRED',
    );
    expectCode(
      () =>
        transitionCase(
          opened,
          'in_progress',
          { reason: 'engaged', actorId: 'agent-7' },
          { now: () => new Date('nope') },
        ),
      'CASE_CLOCK_INVALID',
    );
  });
});

// --- escalation -----------------------------------------------------------------------

describe('escalateCase — the priority ladder (low → normal → high → urgent)', () => {
  it('raises the priority, appends the audit row and emits case.escalated', () => {
    const opened = open(1).case;
    const { case: next, events } = escalateCase(
      opened,
      { to: 'high', reason: 'promise broken twice', actorId: 'supervisor-1' },
      clock1,
    );
    expect(next.priority).toBe('high');
    expect(next.priorityChanges).toEqual([
      { from: 'normal', to: 'high', reason: 'promise broken twice', actorId: 'supervisor-1', at: new Date(T1) },
    ]);
    expect(opened.priorityChanges).toEqual([]); // input untouched
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.name).toBe('case.escalated');
    expect(event.payload).toEqual({
      caseId: opened.id,
      caseNumber: opened.caseNumber,
      orgId: ORG,
      from: 'normal',
      to: 'high',
      reason: 'promise broken twice',
      actorId: 'supervisor-1',
      escalatedAt: T1,
    });
  });

  it.each([
    ['same rank is a no-op, not an escalation', 'normal'],
    ['downgrades are refused', 'low'],
  ] as const)('%s (%s)', (_label, to) => {
    const opened = open(1, [], clock0, { priority: 'normal' }).case;
    expectCode(
      () => escalateCase(opened, { to, reason: 'x', actorId: 'agent-7' }, clock1),
      'CASE_ESCALATION_INVALID',
    );
  });

  it('escalating a terminal case is refused (nothing left to escalate)', () => {
    expectCode(
      () =>
        escalateCase(
          caseAt('resolved'),
          { to: 'urgent', reason: 'x', actorId: 'agent-7' },
          clock1,
        ),
      'CASE_CLOSED',
    );
  });

  it('validates the target priority, reason and actor', () => {
    const opened = open(1).case;
    expectCode(
      () => escalateCase(opened, { to: 'extreme', reason: 'x', actorId: 'agent-7' }, clock1),
      'CASE_PRIORITY_INVALID',
    );
    expectCode(
      () => escalateCase(opened, { to: 'urgent', reason: ' ', actorId: 'agent-7' }, clock1),
      'CASE_REASON_REQUIRED',
    );
    expectCode(
      () => escalateCase(opened, { to: 'urgent', reason: 'x', actorId: '' }, clock1),
      'CASE_ACTOR_REQUIRED',
    );
  });

  it('climbs the full ladder one bump at a time (low → urgent across three escalations)', () => {
    let current = open(1, [], clock0, { priority: 'low' }).case;
    for (const to of ['normal', 'high', 'urgent'] as const) {
      current = escalateCase(current, { to, reason: `to ${to}`, actorId: 'agent-7' }, clock1).case;
      expect(current.priority).toBe(to);
    }
    expect(current.priorityChanges).toHaveLength(3);
  });
});

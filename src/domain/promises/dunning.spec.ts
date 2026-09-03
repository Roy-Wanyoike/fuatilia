import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  DEFAULT_DUNNING_LADDER,
  DEFAULT_ESCALATION_AFTER_DAYS,
  assertDunningSendable,
  assertLadder,
  dueSteps,
  dunningEscalatedEvent,
  escalationDue,
  evaluateDunningSend,
  orchestrateDunning,
  utcDaysBetween,
  type DunningEscalationFacts,
  type DunningFacts,
  type DunningStep,
} from './dunning';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(651);
const SUBJECT = uid(652); // opaque receivable/case id — the dunning subject

const DUE = '2026-03-10T00:00:00.000Z';
/** `now` instant (dunning takes the instant directly — pure, clock-free). */
const d = (iso: string): Date => new Date(iso);
/** Injected clock (for the event envelope's occurredAt). */
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const facts = (overrides: Partial<DunningFacts> = {}): DunningFacts => ({
  dueDate: d(DUE),
  sentSteps: [],
  consentRef: null,
  subjectId: SUBJECT,
  orgId: ORG,
  ...overrides,
});

const withConsent = (overrides: Partial<DunningFacts> = {}): DunningFacts =>
  facts({ consentRef: 'consent-grant-77', ...overrides });

const escalationFacts = (
  overrides: Partial<DunningEscalationFacts> = {},
): DunningEscalationFacts => ({
  lastSendAt: null,
  lastResponseAt: null,
  stepKey: 'overdue_day_3',
  channel: 'whatsapp',
  subjectId: SUBJECT,
  orgId: ORG,
  ...overrides,
});

const keysOf = (steps: readonly DunningStep[]): string[] => steps.map((s) => s.key);

// --- the ladder is configuration (SPEC §18) ---------------------------------------------

describe('DEFAULT_DUNNING_LADDER — SPEC §18 as pure config', () => {
  it('encodes the documented cadence exactly (table)', () => {
    const expected: Array<[string, number, string, string, boolean]> = [
      ['pre_due_reminder', -3, 'reminder', 'email', false],
      ['due_date_request', 0, 'payment_request', 'email', false],
      ['overdue_day_3', 3, 'whatsapp', 'whatsapp', true],
      ['overdue_day_7', 7, 'sms', 'sms', false],
      ['overdue_day_14', 14, 'collector_task', 'task', false],
      ['overdue_day_30', 30, 'manager_escalation', 'task', false],
      ['overdue_day_45', 45, 'payment_plan_offer', 'email', false],
      ['overdue_day_60', 60, 'recovery_workflow', 'task', false],
    ];
    expect(DEFAULT_DUNNING_LADDER.map((s) => s.key)).toEqual(expected.map((r) => r[0]));
    for (const [i, [key, dayOffset, kind, channel, requiresConsent]] of expected.entries()) {
      const s = DEFAULT_DUNNING_LADDER[i]!;
      expect({
        key: s.key,
        dayOffset: s.dayOffset,
        kind: s.kind,
        channel: s.channel,
        requiresConsent: s.requiresConsent,
      }).toEqual({ key, dayOffset, kind, channel, requiresConsent });
    }
  });

  it('survives its own validation (the shipped ladder is well-formed)', () => {
    expect(assertLadder(DEFAULT_DUNNING_LADDER)).toBe(DEFAULT_DUNNING_LADDER);
  });
});

describe('assertLadder — configuration validation', () => {
  it('accepts a custom ladder', () => {
    const custom: DunningStep[] = [
      { key: 'a', dayOffset: -1, kind: 'reminder', channel: 'email', requiresConsent: false },
      { key: 'b', dayOffset: 5, kind: 'sms', channel: 'sms', requiresConsent: false },
    ];
    expect(() => assertLadder(custom)).not.toThrow();
  });

  it('refuses malformed ladders (table)', () => {
    const good = (over: Partial<DunningStep> = {}, key = 'a'): DunningStep => ({
      key,
      dayOffset: 0,
      kind: 'reminder',
      channel: 'email',
      requiresConsent: false,
      ...over,
    });
    const table: DunningStep[][] = [
      [],
      [good({ key: '  ' })],
      [good({}, 'a'), good({}, 'a')],
      [good({ dayOffset: 1.5 })],
      [good({ dayOffset: 5 }, 'late'), good({ dayOffset: 2 }, 'early')],
    ];
    for (const ladder of table) {
      expectCode(() => assertLadder(ladder), 'DUNNING_LADDER_INVALID');
    }
  });
});

// --- day arithmetic -----------------------------------------------------------------

describe('utcDaysBetween — deterministic UTC day boundaries', () => {
  it('counts whole UTC calendar days (table)', () => {
    const table: Array<[string, string, number]> = [
      ['2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', 0],
      ['2026-03-10T00:00:00.000Z', '2026-03-10T23:59:59.999Z', 0],
      ['2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z', 1],
      ['2026-03-10T12:00:00.000Z', '2026-03-11T06:00:00.000Z', 1],
      ['2026-03-10T00:00:00.000Z', '2026-03-07T00:00:00.000Z', -3],
      ['2026-03-10T00:00:00.000Z', '2026-05-09T00:00:00.000Z', 60], // crosses a month boundary
    ];
    for (const [from, to, days] of table) {
      expect(utcDaysBetween(d(from), d(to)), `${from} → ${to}`).toBe(days);
    }
  });
});

// --- step selection -----------------------------------------------------------------

describe('dueSteps — cadence selection against a fake clock', () => {
  it('nothing is due before the pre-due window', () => {
    expect(dueSteps(d('2026-03-05T23:59:59.999Z'), facts())).toEqual([]);
  });

  it('day-boundary table: each cadence rung opens at UTC midnight of its day', () => {
    const table: Array<[string, string[]]> = [
      ['2026-03-07T00:00:00.000Z', ['pre_due_reminder']], // D-3 exactly
      ['2026-03-07T23:59:59.999Z', ['pre_due_reminder']], // still only the pre-due step
      ['2026-03-09T00:00:00.000Z', ['pre_due_reminder']], // D-1
      ['2026-03-10T00:00:00.000Z', ['pre_due_reminder', 'due_date_request']], // due date
      ['2026-03-12T23:59:59.999Z', ['pre_due_reminder', 'due_date_request']], // D+2
      ['2026-03-13T00:00:00.000Z', ['pre_due_reminder', 'due_date_request', 'overdue_day_3']],
      ['2026-03-17T00:00:00.000Z', ['pre_due_reminder', 'due_date_request', 'overdue_day_3', 'overdue_day_7']],
      [
        '2026-03-24T00:00:00.000Z',
        [
          'pre_due_reminder',
          'due_date_request',
          'overdue_day_3',
          'overdue_day_7',
          'overdue_day_14',
        ],
      ],
      [
        '2026-04-09T00:00:00.000Z',
        [
          'pre_due_reminder',
          'due_date_request',
          'overdue_day_3',
          'overdue_day_7',
          'overdue_day_14',
          'overdue_day_30',
        ],
      ],
      [
        '2026-05-09T00:00:00.000Z',
        [
          'pre_due_reminder',
          'due_date_request',
          'overdue_day_3',
          'overdue_day_7',
          'overdue_day_14',
          'overdue_day_30',
          'overdue_day_45',
          'overdue_day_60',
        ],
      ], // 60+ days → recovery workflow
    ];
    for (const [now, expected] of table) {
      expect(keysOf(dueSteps(d(now), facts())), `now=${now}`).toEqual(expected);
    }
  });

  it('sentSteps idempotence: a step never fires twice', () => {
    const sent = dueSteps(d('2026-03-10T00:00:00.000Z'), facts()).map((s) => s.key);
    expect(sent).toEqual(['pre_due_reminder', 'due_date_request']);
    // D+7: day_3 was already handled, day_7 is the only new rung
    const next = dueSteps(
      d('2026-03-17T00:00:00.000Z'),
      facts({ sentSteps: [...sent, 'overdue_day_3'] }),
    );
    expect(keysOf(next)).toEqual(['overdue_day_7']);
  });

  it('a fully-sent subject draws nothing, even 60+ days out', () => {
    const everything = DEFAULT_DUNNING_LADDER.map((s) => s.key);
    expect(dueSteps(d('2026-05-20T00:00:00.000Z'), facts({ sentSteps: everything }))).toEqual([]);
  });

  it('returns steps in ladder order regardless of selection size (backlog oldest-first)', () => {
    const due = dueSteps(d('2026-03-24T00:00:00.000Z'), facts());
    const offsets = due.map((s) => s.dayOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('is consent-blind — selection stays observable, the orchestrator gates', () => {
    expect(keysOf(dueSteps(d('2026-03-13T00:00:00.000Z'), facts()))).toContain('overdue_day_3');
  });

  it('works on a custom ladder', () => {
    const custom: DunningStep[] = [
      {
        key: 'only_call',
        dayOffset: 2,
        kind: 'whatsapp',
        channel: 'whatsapp',
        requiresConsent: true,
      },
    ];
    expect(keysOf(dueSteps(d('2026-03-12T00:00:00.000Z'), facts(), custom))).toEqual(['only_call']);
    expect(dueSteps(d('2026-03-11T23:59:59.999Z'), facts(), custom)).toEqual([]);
  });

  it('refuses invalid inputs (table)', () => {
    expectCode(() => dueSteps(new Date('nope'), facts()), 'DUNNING_CLOCK_INVALID');
    expectCode(
      () => dueSteps(d('2026-03-13T00:00:00.000Z'), facts({ dueDate: new Date('nope') })),
      'DUNNING_FACTS_INVALID',
    );
  });
});

// --- the consent gate (K2) -----------------------------------------------------------

describe('evaluateDunningSend — the K2 decision table', () => {
  const gated: DunningStep = {
    key: 'overdue_day_3',
    dayOffset: 3,
    kind: 'whatsapp',
    channel: 'whatsapp',
    requiresConsent: true,
  };
  const open: DunningStep = {
    key: 'overdue_day_7',
    dayOffset: 7,
    kind: 'sms',
    channel: 'sms',
    requiresConsent: false,
  };

  it('consent-gated steps need a real consentRef (table)', () => {
    const table: Array<[string | null | undefined, string | 'ok']> = [
      [null, 'DUNNING_CONSENT_REQUIRED'],
      [undefined, 'DUNNING_CONSENT_REQUIRED'],
      ['   ', 'DUNNING_CONSENT_REQUIRED'],
      ['', 'DUNNING_CONSENT_REQUIRED'],
      ['consent-grant-77', 'ok'],
    ];
    for (const [consentRef, expected] of table) {
      const decision = evaluateDunningSend(gated, consentRef);
      if (expected === 'ok') {
        expect(decision.allowed, String(consentRef)).toBe(true);
      } else {
        expect(decision.allowed, String(consentRef)).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe(expected);
      }
    }
  });

  it('steps without the consent flag always pass', () => {
    for (const ref of [null, undefined, 'consent-grant-77']) {
      expect(evaluateDunningSend(open, ref).allowed).toBe(true);
    }
  });

  it('assertDunningSendable throws the stable code only for gated-without-consent', () => {
    expectCode(() => assertDunningSendable(gated, null), 'DUNNING_CONSENT_REQUIRED');
    expectCode(() => assertDunningSendable(gated, '   '), 'DUNNING_CONSENT_REQUIRED');
    expect(() => assertDunningSendable(gated, 'consent-grant-77')).not.toThrow();
    expect(() => assertDunningSendable(open, null)).not.toThrow();
  });
});

// --- the orchestrator -----------------------------------------------------------------

describe('orchestrateDunning — sends, refusals and the observability invariant', () => {
  it('emits dunning.stepDue sends with full payloads when consent exists', () => {
    const plan = orchestrateDunning(
      d('2026-03-13T00:00:00.000Z'),
      withConsent(),
      at('2026-03-13T00:00:00.000Z'),
    );
    expect(plan.blocked).toEqual([]);
    expect(keysOf(plan.sends.map((s) => s.step))).toEqual([
      'pre_due_reminder',
      'due_date_request',
      'overdue_day_3',
    ]);
    const whatsapp = plan.sends.find((s) => s.step.key === 'overdue_day_3')!;
    expect(whatsapp.event.name).toBe('dunning.stepDue');
    expect(whatsapp.event.version).toBe(1);
    expect(whatsapp.event.aggregateId).toBe(SUBJECT);
    expect(whatsapp.event.occurredAt).toBe('2026-03-13T00:00:00.000Z');
    expect(whatsapp.event.payload).toMatchObject({
      orgId: ORG,
      subjectId: SUBJECT,
      stepKey: 'overdue_day_3',
      dayOffset: 3,
      channel: 'whatsapp',
      requiresConsent: true,
      dueDate: DUE,
    });
  });

  it('refuses consent-gated sends without consentRef — stable code + observable event', () => {
    const plan = orchestrateDunning(
      d('2026-03-13T00:00:00.000Z'),
      facts(),
      at('2026-03-13T00:00:00.000Z'),
    );
    expect(plan.sends.map((s) => s.step.key)).toEqual(['pre_due_reminder', 'due_date_request']);
    expect(plan.blocked.map((b) => b.step.key)).toEqual(['overdue_day_3']);
    expect(plan.blocked[0]!.reason).toBe('DUNNING_CONSENT_REQUIRED');
    expect(plan.blocked[0]!.event.name).toBe('collections.dunningBlockedNoConsent');
    expect(plan.blocked[0]!.event.version).toBe(1);
    expect(plan.blocked[0]!.event.aggregateId).toBe(SUBJECT);
    expect(plan.blocked[0]!.event.payload).toMatchObject({
      orgId: ORG,
      subjectId: SUBJECT,
      stepKey: 'overdue_day_3',
      channel: 'whatsapp',
      blockedAt: '2026-03-13T00:00:00.000Z',
    });
  });

  it('partitions every due step into exactly one of sends | blocked (60-day backlog)', () => {
    const plan = orchestrateDunning(
      d('2026-05-09T00:00:00.000Z'),
      facts(),
      at('2026-05-09T00:00:00.000Z'),
    );
    const due = keysOf(dueSteps(d('2026-05-09T00:00:00.000Z'), facts()));
    const covered = [...plan.sends.map((s) => s.step.key), ...plan.blocked.map((b) => b.step.key)];
    expect(covered.sort()).toEqual([...due].sort());
    expect(new Set(covered).size).toBe(covered.length);
    expect(plan.sends).toHaveLength(7);
    expect(plan.blocked.map((b) => b.step.key)).toEqual(['overdue_day_3']);
  });

  it('the same tick with consent sends everything (no residual blocks)', () => {
    const plan = orchestrateDunning(
      d('2026-05-09T00:00:00.000Z'),
      withConsent(),
      at('2026-05-09T00:00:00.000Z'),
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.sends).toHaveLength(8);
  });

  it('honours sentSteps so the scheduler cannot double-send', () => {
    const first = orchestrateDunning(
      d('2026-03-10T00:00:00.000Z'),
      withConsent(),
      at('2026-03-10T00:00:00.000Z'),
    );
    const sentKeys = first.sends.map((s) => s.step.key);
    const next = orchestrateDunning(
      d('2026-03-10T12:00:00.000Z'),
      withConsent({ sentSteps: sentKeys }),
      at('2026-03-10T12:00:00.000Z'),
    );
    expect(next.sends).toEqual([]);
    expect(next.blocked).toEqual([]);
  });

  it('supports custom ladders end to end', () => {
    const custom: DunningStep[] = [
      {
        key: 'call_day_1',
        dayOffset: 1,
        kind: 'whatsapp',
        channel: 'whatsapp',
        requiresConsent: true,
      },
      { key: 'sms_day_2', dayOffset: 2, kind: 'sms', channel: 'sms', requiresConsent: false },
    ];
    const plan = orchestrateDunning(
      d('2026-03-12T00:00:00.000Z'),
      facts(),
      at('2026-03-12T00:00:00.000Z'),
      custom,
    );
    expect(plan.sends.map((s) => s.step.key)).toEqual(['sms_day_2']);
    expect(plan.blocked.map((b) => b.step.key)).toEqual(['call_day_1']);
  });
});

// --- escalation (facts-driven, deterministic) -------------------------------------------

describe('escalationDue — no-response windows', () => {
  it('is false when nothing was ever sent', () => {
    expect(escalationDue(d('2026-04-30T00:00:00.000Z'), escalationFacts({ lastSendAt: null }))).toBe(
      false,
    );
  });

  it('fires only after N whole days without a response (default 3)', () => {
    expect(DEFAULT_ESCALATION_AFTER_DAYS).toBe(3);
    const table: Array<[string, boolean]> = [
      ['2026-03-13T00:00:00.000Z', false], // +0 days
      ['2026-03-14T00:00:00.000Z', false], // +1
      ['2026-03-15T00:00:00.000Z', false], // +2
      ['2026-03-16T00:00:00.000Z', true], // +3 — the boundary
      ['2026-03-20T00:00:00.000Z', true], // +7
    ];
    for (const [now, expected] of table) {
      expect(
        escalationDue(d(now), escalationFacts({ lastSendAt: d('2026-03-13T00:00:00.000Z') })),
        `now=${now}`,
      ).toBe(expected);
    }
  });

  it('a response AFTER the last send cancels escalation; one BEFORE does not', () => {
    const sent = d('2026-03-13T00:00:00.000Z');
    expect(
      escalationDue(
        d('2026-03-20T00:00:00.000Z'),
        escalationFacts({ lastSendAt: sent, lastResponseAt: d('2026-03-14T00:00:00.000Z') }),
      ),
    ).toBe(false);
    expect(
      escalationDue(
        d('2026-03-20T00:00:00.000Z'),
        escalationFacts({ lastSendAt: sent, lastResponseAt: d('2026-03-10T00:00:00.000Z') }),
      ),
    ).toBe(true);
  });

  it('honours a configurable window (facts-driven)', () => {
    const sent = d('2026-03-13T00:00:00.000Z');
    const table: Array<[number, string, boolean]> = [
      [7, '2026-03-19T23:59:59.999Z', false],
      [7, '2026-03-20T00:00:00.000Z', true],
      [0, '2026-03-13T00:00:00.000Z', true],
      [30, '2026-04-12T00:00:00.000Z', true],
    ];
    for (const [escalationAfterDays, now, expected] of table) {
      expect(
        escalationDue(d(now), escalationFacts({ lastSendAt: sent, escalationAfterDays })),
        `days=${escalationAfterDays} now=${now}`,
      ).toBe(expected);
    }
  });

  it('refuses invalid windows', () => {
    expectCode(
      () =>
        escalationDue(
          d('2026-03-20T00:00:00.000Z'),
          escalationFacts({
            lastSendAt: d('2026-03-13T00:00:00.000Z'),
            escalationAfterDays: -1,
          }),
        ),
      'DUNNING_ESCALATION_INVALID',
    );
  });

  it('dunningEscalatedEvent carries the wait evidence and refuses premature escalation', () => {
    const premature = escalationFacts({ lastSendAt: d('2026-03-13T00:00:00.000Z') });
    expectCode(
      () => dunningEscalatedEvent(d('2026-03-15T00:00:00.000Z'), premature, at('2026-03-15T00:00:00.000Z')),
      'DUNNING_ESCALATION_NOT_DUE',
    );
    const event = dunningEscalatedEvent(
      d('2026-03-16T00:00:00.000Z'),
      escalationFacts({ lastSendAt: d('2026-03-13T00:00:00.000Z') }),
      at('2026-03-16T00:00:00.000Z'),
    );
    expect(event.name).toBe('dunning.escalated');
    expect(event.aggregateId).toBe(SUBJECT);
    expect(event.payload).toMatchObject({
      orgId: ORG,
      subjectId: SUBJECT,
      stepKey: 'overdue_day_3',
      channel: 'whatsapp',
      lastSendAt: '2026-03-13T00:00:00.000Z',
      waitedDays: 3,
      escalatedAt: '2026-03-16T00:00:00.000Z',
    });
  });
});

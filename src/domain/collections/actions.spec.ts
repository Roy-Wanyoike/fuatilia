import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { openCase, transitionCase, type CollectionsCase } from './case';
import {
  CASE_ACTION_TYPES,
  completeAction,
  recordAction,
  tryRecordAction,
  type RecordActionArgs,
} from './actions';
import { COLLECTIONS_EVENT_NAMES } from './events';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const R1 = uid(951);
const COLLECTOR = uid(971);
const CONSENT = 'consent-grant-abc123';

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

/** A live in-progress case (actions are recorded on engaged cases). */
const liveCase = (): CollectionsCase =>
  transitionCase(
    openCase(
      {
        id: uid(830),
        orgId: ORG,
        receivableIds: [R1],
        collectorId: COLLECTOR,
        openedBy: 'agent-7',
        sequenceNo: 1,
      },
      [],
      clock0,
    ).case,
    'in_progress',
    { reason: 'agent engaged', actorId: 'agent-7' },
    clock0,
  ).case;

const record = (
  c: CollectionsCase,
  args: Partial<RecordActionArgs> = {},
  clock: Clock = clock1,
): { case: CollectionsCase; eventName: string } => {
  const result = recordAction(
    c,
    {
      type: 'call',
      scheduledFor: new Date('2026-04-02T09:00:00.000Z'),
      actorId: 'agent-7',
      ...args,
    },
    clock,
  );
  return { case: result.case, eventName: result.events[0].name };
};

// --- recording -----------------------------------------------------------------

describe('recordAction — the append-only action log', () => {
  it('appends an entry and emits case.actionRecorded with the full payload (v1)', () => {
    const c = liveCase();
    const before = c.actions.length;
    const { case: next, eventName } = record(c, { type: 'call' }, clock1);
    expect(eventName).toBe('case.actionRecorded');
    expect(next.actions).toHaveLength(before + 1);
    expect(c.actions).toHaveLength(before); // input untouched — copy-on-write
    const entry = next.actions[0]!;
    expect(entry).toEqual({
      id: `${c.id}/actions/1`,
      type: 'call',
      scheduledFor: new Date('2026-04-02T09:00:00.000Z'),
      outcome: null,
      completedAt: null,
      completedBy: null,
      consentRef: null,
      source: 'manual',
      actorId: 'agent-7',
      recordedAt: new Date(T1),
    });
  });

  it('the case.actionRecorded payload travels narrow, serializable fields', () => {
    const c = liveCase();
    const { case: next } = record(c, { type: 'letter' }, clock1);
    const result = recordAction(next, { type: 'call', actorId: 'agent-9', scheduledFor: new Date('2026-04-03T09:00:00.000Z') }, clock2);
    const [event] = result.events;
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(c.id);
    expect(event.occurredAt).toBe(T2);
    expect(event.name).toBe('case.actionRecorded');
    expect(event.payload).toEqual({
      caseId: c.id,
      caseNumber: c.caseNumber,
      orgId: ORG,
      actionId: `${c.id}/actions/2`,
      actionType: 'call',
      scheduledFor: '2026-04-03T09:00:00.000Z',
      outcome: null,
      completedAt: null,
      consentRef: null,
      actorId: 'agent-9',
      recordedAt: T2,
    });
  });

  it.each(CASE_ACTION_TYPES.map((t) => [t] as const))('accepts action type %s', (type) => {
    const { case: next } = record(liveCase(), { type, source: 'manual' });
    expect(next.actions.at(-1)?.type).toBe(type);
  });

  it('derived action ids stay unique on the append-only log (…/actions/N grows)', () => {
    let c = liveCase();
    for (let i = 1; i <= 3; i++) {
      c = record(c).case;
      expect(c.actions.at(-1)?.id).toBe(`${c.id}/actions/${i}`);
    }
    expect(c.actions.map((a) => a.id)).toHaveLength(3);
    expect(COLLECTIONS_EVENT_NAMES).toContain('case.actionRecorded');
  });

  it('recording with an outcome backfills the completion (already happened)', () => {
    const { case: next } = record(liveCase(), { type: 'call', outcome: 'no answer, left voicemail' }, clock1);
    const entry = next.actions[0]!;
    expect(entry.outcome).toBe('no answer, left voicemail');
    expect(entry.completedAt).toEqual(new Date(T1));
    expect(entry.completedBy).toBe('agent-7');
  });

  it('validation table — malformed requests carry stable codes', () => {
    const c = liveCase();
    const base = { scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'agent-7' };
    expectCode(() => recordAction(c, { ...base, type: 'fax' }, clock1), 'CASE_ACTION_TYPE_INVALID');
    expectCode(
      () => recordAction(c, { ...base, type: 'sms', source: 'telepathy' }, clock1),
      'CASE_ACTION_SOURCE_INVALID',
    );
    expectCode(
      () => recordAction(c, { ...base, type: 'sms', scheduledFor: new Date('nope') }, clock1),
      'CASE_SCHEDULED_FOR_INVALID',
    );
    expectCode(() => recordAction(c, { ...base, type: 'call' }, { now: () => new Date('nope') }), 'CASE_CLOCK_INVALID');
    expectCode(() => recordAction(c, { ...base, type: 'call', actorId: ' ' }, clock1), 'CASE_ACTOR_REQUIRED');
    expectCode(() => recordAction(c, { ...base, type: 'call', id: ' ' }, clock1), 'CASE_ACTION_ID_REQUIRED');
    expectCode(
      () => recordAction(c, { ...base, type: 'call', outcome: '  ' }, clock1),
      'CASE_OUTCOME_REQUIRED',
    );
    expectCode(
      () => recordAction(c, { ...base, type: 'sms', source: 'automated', consentRef: '  ' }, clock1),
      'CASE_CONSENT_REF_INVALID',
    );
  });
});

// --- K2 dunning-consent gate -------------------------------------------------------

describe('recordAction — the K2 dunning-consent gate', () => {
  it.each(['sms', 'whatsapp'] as const)(
    'blocks an automated %s without a consentRef — DUNNING_CONSENT_REQUIRED, log untouched',
    (type) => {
      const c = liveCase();
      expectCode(
        () => recordAction(c, { type, source: 'automated', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' }, clock1),
        'DUNNING_CONSENT_REQUIRED',
      );
      expect(c.actions).toHaveLength(0); // nothing was appended, nothing was sent
    },
  );

  it.each(['sms', 'whatsapp'] as const)(
    'an automated %s WITH a consentRef goes out and stores the reference',
    (type) => {
      const { case: next } = record(liveCase(), { type, source: 'automated', consentRef: CONSENT });
      const entry = next.actions[0]!;
      expect(entry.consentRef).toBe(CONSENT);
      expect(entry.source).toBe('automated');
    },
  );

  it.each(['sms', 'whatsapp'] as const)(
    'a MANUAL %s needs no consentRef (a human chose to send)',
    (type) => {
      const { case: next } = record(liveCase(), { type, source: 'manual' });
      expect(next.actions[0]?.consentRef).toBeNull();
    },
  );

  it('defaults outbound types to automated — a forgotten flag must not bypass the gate', () => {
    const c = liveCase();
    expectCode(
      () => recordAction(c, { type: 'whatsapp', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' }, clock1),
      'DUNNING_CONSENT_REQUIRED',
    );
    const { case: next } = record(c, { type: 'sms', consentRef: CONSENT });
    expect(next.actions[0]?.source).toBe('automated');
  });

  it.each(['call', 'letter', 'fieldVisit', 'escalation'] as const)(
    '%s is never consent-gated, even from automation',
    (type) => {
      const { case: next } = record(liveCase(), { type, source: 'automated' });
      expect(next.actions[0]?.type).toBe(type);
    },
  );

  it('terminal cases seal the log — actions refused on resolved AND closed_inactive', () => {
    for (const status of ['resolved', 'closed_inactive'] as const) {
      const c = transitionCase(
        transitionCase(
          openCase(
            { id: uid(831), orgId: ORG, receivableIds: [R1], collectorId: COLLECTOR, openedBy: 'a', sequenceNo: 2 },
            [],
            clock0,
          ).case,
          'in_progress',
          { reason: 'engaged', actorId: 'agent-7' },
          clock0,
        ).case,
        status,
        { reason: 'done', actorId: 'agent-7' },
        clock0,
      ).case;
      expectCode(
        () => recordAction(c, { type: 'call', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'agent-7' }, clock1),
        'CASE_CLOSED',
      );
    }
  });
});

// --- completing -----------------------------------------------------------------

describe('completeAction — stamping the outcome', () => {
  it('stamps outcome + completedAt + completedBy on a fresh copy; emits no event', () => {
    const c = liveCase();
    const recorded = record(c, { type: 'call' }).case;
    const { case: next, events } = completeAction(
      recorded,
      `${c.id}/actions/1`,
      { outcome: 'promised to pay Friday', actorId: 'agent-9' },
      clock2,
    );
    expect(events).toEqual([]); // the issue-#8 catalog has no case.actionCompleted
    const entry = next.actions[0]!;
    expect(entry.outcome).toBe('promised to pay Friday');
    expect(entry.completedAt).toEqual(new Date(T2));
    expect(entry.completedBy).toBe('agent-9');
    expect(entry.actorId).toBe('agent-7'); // recorder preserved
    expect(recorded.actions[0]?.completedAt).toBeNull(); // input untouched
  });

  it('defaults completedBy to the recording actor', () => {
    const recorded = record(liveCase(), { type: 'fieldVisit' }).case;
    const { case: next } = completeAction(
      recorded,
      `${recorded.id}/actions/1`,
      { outcome: 'met the finance manager' },
      clock2,
    );
    expect(next.actions[0]?.completedBy).toBe('agent-7');
  });

  it('completing twice is refused (CASE_ACTION_ALREADY_COMPLETED)', () => {
    const recorded = record(liveCase(), { type: 'call' }).case;
    const done = completeAction(
      recorded,
      `${recorded.id}/actions/1`,
      { outcome: 'promised to pay Friday' },
      clock2,
    ).case;
    expectCode(
      () =>
        completeAction(
          done,
          `${recorded.id}/actions/1`,
          { outcome: 'promised again' },
          clock2,
        ),
      'CASE_ACTION_ALREADY_COMPLETED',
    );
  });

  it('a backfilled entry is already completed — completing it is refused', () => {
    const backfilled = record(liveCase(), { type: 'call', outcome: 'done on the spot' }).case;
    expectCode(
      () =>
        completeAction(
          backfilled,
          `${backfilled.id}/actions/1`,
          { outcome: 'again' },
          clock2,
        ),
      'CASE_ACTION_ALREADY_COMPLETED',
    );
  });

  it('unknown action id → CASE_ACTION_NOT_FOUND; blank outcome → CASE_OUTCOME_REQUIRED', () => {
    const recorded = record(liveCase(), { type: 'call' }).case;
    expectCode(
      () => completeAction(recorded, 'no-such-action', { outcome: 'x' }, clock2),
      'CASE_ACTION_NOT_FOUND',
    );
    expectCode(
      () => completeAction(recorded, `${recorded.id}/actions/1`, { outcome: ' ' }, clock2),
      'CASE_OUTCOME_REQUIRED',
    );
  });

  it('completion is refused on terminal cases (CASE_CLOSED)', () => {
    const c = liveCase();
    const recorded = record(c, { type: 'call' }).case;
    const closed = transitionCase(
      recorded,
      'resolved',
      { reason: 'settled', actorId: 'agent-7' },
      clock2,
    ).case;
    expectCode(
      () => completeAction(closed, `${c.id}/actions/1`, { outcome: 'late stamp' }, clock2),
      'CASE_CLOSED',
    );
  });
});

// --- tryRecordAction — the K2 refusal as a value -----------------------------------

describe('tryRecordAction — refusal-as-value with the compliance event', () => {
  it('returns the DUNNING_CONSENT_REQUIRED rejection AND the dunningBlockedNoConsent event', () => {
    const c = liveCase();
    const result = tryRecordAction(
      c,
      { type: 'whatsapp', source: 'automated', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' },
      clock1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('DUNNING_CONSENT_REQUIRED');
    expect(result.blockedEvent.name).toBe('collections.dunningBlockedNoConsent');
    expect(result.blockedEvent.version).toBe(1);
    expect(result.blockedEvent.occurredAt).toBe(T1);
    expect(result.blockedEvent.payload).toEqual({
      caseId: c.id,
      caseNumber: c.caseNumber,
      orgId: ORG,
      receivableIds: [R1],
      actionType: 'whatsapp',
      scheduledFor: '2026-04-02T09:00:00.000Z',
      actorId: 'bot-1',
      reason: result.error.message,
      blockedAt: T1,
    });
    expect(c.actions).toHaveLength(0); // the send never happened
  });

  it('the allowed path mirrors recordAction (ok: true with case + events)', () => {
    const c = liveCase();
    const result = tryRecordAction(
      c,
      { type: 'sms', source: 'automated', consentRef: CONSENT, scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' },
      clock1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.case.actions).toHaveLength(1);
    expect(result.events.map((e) => e.name)).toEqual(['case.actionRecorded']);
  });

  it('non-consent errors are NOT swallowed — malformed input still throws its stable code', () => {
    const c = liveCase();
    expectCode(
      () =>
        tryRecordAction(
          c,
          { type: 'fax', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' },
          clock1,
        ),
      'CASE_ACTION_TYPE_INVALID',
    );
    const closed = transitionCase(c, 'resolved', { reason: 'settled', actorId: 'agent-7' }, clock2).case;
    expectCode(
      () =>
        tryRecordAction(
          closed,
          { type: 'sms', scheduledFor: new Date('2026-04-02T09:00:00.000Z'), actorId: 'bot-1' },
          clock1,
        ),
      'CASE_CLOSED',
    );
  });
});

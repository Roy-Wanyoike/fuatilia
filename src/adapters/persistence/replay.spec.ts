/**
 * Replay specs (issue #61, F32) — the read half of the file-backed
 * AuthStore. `replayJournal` and `parseSnapshot` are PURE functions over
 * text, so these are pure tests: no I/O, no clock, no tmpdirs.
 *
 * Covered: determinism/idempotence, the full quarantine taxonomy (blank,
 * corrupt, torn trailing line, unknown kind, malformed row, non-monotonic
 * seq — each counted, none fatal, none poisoning), the snapshot-fold
 * contract (`minSeq` lines are neither applied nor quarantined), base-state
 * immutability, latest-fact-wins upserts, and the snapshot parser's
 * all-or-nothing validation.
 */
import { describe, expect, it } from 'vitest';
import type { User } from '../../domain/auth/user';
import type { StoredEvent } from '../http/runtime/memory';
import type { JournalEntry, JournalKind } from './journal';
import {
  emptyReplayState,
  parseSnapshot,
  replayJournal,
  SNAPSHOT_FORMAT,
} from './replay';

const T0 = '2026-03-01T08:00:00.000Z';

let seq = 0;
const entry = (kind: JournalKind, row: unknown, at: string = T0): string =>
  JSON.stringify({ seq: ++seq, kind, at, row } satisfies JournalEntry);

const userRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  email: 'ada@fuatilia.test',
  username: 'ada',
  displayName: 'Ada Kimathi',
  status: 'active',
  createdAt: T0,
  suspendedAt: null,
  suspendedReason: null,
  reactivatedAt: null,
  deactivatedAt: null,
  ...overrides,
});

const eventRow = (name: string): Record<string, unknown> => ({
  name,
  version: 1,
  aggregateId: '00000000-0000-4000-8000-000000000001',
  payload: { ok: true },
  occurredAt: T0,
});

describe('replayJournal — determinism and the happy path', () => {
  it('reduces empty input to an empty state with a zeroed report', () => {
    const result = replayJournal('');
    expect(result.report).toEqual({ lines: 0, applied: 0, quarantined: 0 });
    expect(result.lastSeq).toBe(0);
    expect(result.state.users.size).toBe(0);
    expect(result.state.events).toHaveLength(0);
  });

  it('applies a valid user line and revives the ISO strings as Dates', () => {
    const result = replayJournal(`${entry('user', userRow())}\n`);
    expect(result.report).toEqual({ lines: 1, applied: 1, quarantined: 0 });
    const user = result.state.users.get('00000000-0000-4000-8000-000000000001') as User;
    expect(user.displayName).toBe('Ada Kimathi');
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.createdAt.toISOString()).toBe(T0);
    expect(user.suspendedAt).toBeNull();
  });

  it('is deterministic: the same bytes always reduce to the same state and report', () => {
    const raw = `${entry('user', userRow())}\n${entry('event', eventRow('auth.userCreated'))}\n`;
    const first = replayJournal(raw);
    seq = 0; // rebuild identical bytes
    const second = replayJournal(raw);
    expect(second.report).toEqual(first.report);
    expect(second.lastSeq).toBe(first.lastSeq);
    expect([...second.state.users.keys()]).toEqual([...first.state.users.keys()]);
    expect(second.state.events).toEqual(first.state.events);
  });

  it('upserts by aggregate id — latest fact wins for rows, events append', () => {
    seq = 0;
    const raw = [
      entry('user', userRow({ displayName: 'Before' })),
      entry('user', userRow({ displayName: 'After' })),
      entry('event', eventRow('auth.userCreated')),
      entry('event', eventRow('auth.userSuspended')),
    ].join('\n');
    const result = replayJournal(`${raw}\n`);
    expect(result.state.users.size).toBe(1);
    expect(result.state.users.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe('After');
    expect(result.state.events.map((e) => e.name)).toEqual(['auth.userCreated', 'auth.userSuspended']);
    expect(result.report.applied).toBe(4);
  });
});

describe('replayJournal — the quarantine taxonomy (never throws, never poisons)', () => {
  it('quarantines blank lines', () => {
    const result = replayJournal(`\n${entry('user', userRow())}\n\n`);
    expect(result.report).toEqual({ lines: 3, applied: 1, quarantined: 2 });
  });

  it('quarantines corrupt JSON and keeps every earlier and later line', () => {
    seq = 0;
    const raw = [
      entry('user', userRow()),
      '{"seq":2,"kind":"user","at":"' + T0 + '","row":{TRUNCATED',
      entry('event', eventRow('auth.userCreated')),
    ].join('\n');
    const result = replayJournal(`${raw}\n`);
    expect(result.report).toEqual({ lines: 3, applied: 2, quarantined: 1 });
    expect(result.state.users.size).toBe(1);
    expect(result.state.events).toHaveLength(1);
  });

  it('quarantines a torn trailing line (crash mid-write) without a commit mark', () => {
    seq = 0;
    const raw = `${entry('user', userRow())}\n{"seq":2,"kind":"ro`;
    const result = replayJournal(raw);
    expect(result.report).toEqual({ lines: 2, applied: 1, quarantined: 1 });
    expect(result.state.users.size).toBe(1);
  });

  it('quarantines unknown kinds and non-object lines — but still burns their seq slot', () => {
    seq = 0;
    const raw = [
      entry('invoice' as JournalKind, { amountMinor: '100', currency: 'KES' }), // unknown kind, seq 1 — slot burned
      '[1,2,3]', // valid JSON, not an object — quarantined before any seq is readable
      entry('user', userRow()), // seq 2 — must still land
    ].join('\n');
    const result = replayJournal(`${raw}\n`);
    expect(result.report).toEqual({ lines: 3, applied: 1, quarantined: 2 });
    expect(result.lastSeq).toBe(2); // the unknown kind's slot is burned; the valid line lands
    expect(result.state.users.size).toBe(1);
  });

  it('quarantines well-formed envelopes carrying malformed rows', () => {
    seq = 0;
    const raw = [entry('user', { ...userRow(), email: 42 }), entry('user', userRow())].join('\n');
    const result = replayJournal(`${raw}\n`);
    expect(result.report).toEqual({ lines: 2, applied: 1, quarantined: 1 });
    expect(result.state.users.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe(
      'Ada Kimathi',
    );
  });

  it('quarantines non-monotonic (duplicate) sequence numbers inside the tail', () => {
    seq = 0;
    const good = entry('user', userRow()); // seq 1
    const duplicate = good; // the exact same line again — seq 1 twice
    const next = entry('user', userRow({ displayName: 'Second' })); // seq 2
    const result = replayJournal(`${good}\n${duplicate}\n${next}\n`);
    expect(result.report).toEqual({ lines: 3, applied: 2, quarantined: 1 });
    expect(result.lastSeq).toBe(2);
  });

  it('advances lastSeq across a quarantined well-formed line (the high-water mark never regresses)', () => {
    seq = 0;
    // A VALID envelope whose row is malformed: seq 2 is registered and burned,
    // the row is quarantined. (Fully corrupt JSON cannot burn a slot — its seq
    // is unknowable; that case is covered above.)
    const raw = [entry('user', userRow()), entry('user', { broken: true })].join('\n');
    const result = replayJournal(`${raw}\n`);
    expect(result.report.quarantined).toBe(1);
    expect(result.lastSeq).toBe(2);
  });
});

describe('replayJournal — snapshot folding and base state', () => {
  it('skips lines at or below minSeq: counted, but neither applied nor quarantined', () => {
    seq = 0;
    const raw = [entry('user', userRow()), entry('user', userRow({ displayName: 'Tail' }))].join('\n');
    const result = replayJournal(`${raw}\n`, { minSeq: 1 });
    expect(result.report).toEqual({ lines: 2, applied: 1, quarantined: 0 });
    expect(result.state.users.size).toBe(1);
    expect(result.state.users.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe('Tail');
  });

  it('applies the tail onto a base state WITHOUT mutating the base', () => {
    seq = 0;
    const base = emptyReplayState();
    base.users.set('00000000-0000-4000-8000-000000000001', {
      ...(replayJournal(`${entry('user', userRow())}\n`).state.users.get(
        '00000000-0000-4000-8000-000000000001',
      ) as User),
    });
    const baseSnapshot = [...base.users.entries()];

    const tail = replayJournal(`${entry('user', userRow({ displayName: 'Renamed' }))}\n`, {
      base,
    });
    expect(tail.state.users.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe('Renamed');
    // the base was cloned, never mutated
    expect([...base.users.entries()]).toEqual(baseSnapshot);
    expect(base.users.get('00000000-0000-4000-8000-000000000001')?.displayName).toBe('Ada Kimathi');
  });

  it('revives events with the envelope intact and occurredAt normalized to ISO', () => {
    seq = 0;
    const result = replayJournal(`${entry('event', eventRow('auth.userCreated'))}\n`);
    const event = result.state.events[0] as StoredEvent;
    expect(event).toMatchObject({ name: 'auth.userCreated', version: 1, payload: { ok: true } });
    expect(event.occurredAt).toBe(T0);
  });
});

describe('parseSnapshot — all-or-nothing revival', () => {
  const snapshotFor = (userOverrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      format: SNAPSHOT_FORMAT,
      takenAt: T0,
      lastSeq: 1,
      rows: {
        users: [userRow(userOverrides)],
        roles: [],
        grants: [],
        keys: [],
        sessions: [],
        events: [eventRow('auth.userCreated')],
      },
    });

  it('revives a valid snapshot with its lastSeq and revived rows', () => {
    const parsed = parseSnapshot(snapshotFor());
    expect(parsed).not.toBeNull();
    if (parsed === null) return; // TS narrowing — the expect above already guards
    expect(parsed.lastSeq).toBe(1);
    expect(parsed.state.users.size).toBe(1);
    expect(parsed.state.events).toHaveLength(1);
    expect([...parsed.state.users.values()][0]?.createdAt).toBeInstanceOf(Date);
  });

  it('rejects corrupt JSON, foreign format markers and bad lastSeq', () => {
    expect(parseSnapshot('{not json')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ format: 'someone-elses/9', lastSeq: 0, takenAt: T0, rows: {} }))).toBeNull();
    expect(
      parseSnapshot(
        JSON.stringify({ format: SNAPSHOT_FORMAT, lastSeq: -1, takenAt: T0, rows: { users: [], roles: [], grants: [], keys: [], sessions: [], events: [] } }),
      ),
    ).toBeNull();
  });

  it('is all-or-nothing: ONE malformed row invalidates the whole snapshot', () => {
    const parsed = parseSnapshot(snapshotFor({ status: 'unheard-of' }));
    expect(parsed).toBeNull(); // the journal replay covers everything — never a partial boot
  });
});

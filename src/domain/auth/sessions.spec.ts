import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  endSession,
  expireSession,
  openSession,
  revokeSession,
  revokeSessionsForUser,
  sessionState,
  touchSession,
  type Session,
} from './sessions';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(301);
const USER = uid(310);
const OTHER_USER = uid(311);
const SESSION = uid(312);

const T0 = '2026-03-01T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const plus = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const ABSOLUTE_MS = 8 * 60 * 60 * 1000; // 8 hours

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const open = (overrides: Partial<Parameters<typeof openSession>[0]> = {}): Session =>
  openSession(
    {
      sessionId: SESSION,
      userId: USER,
      orgId: ORG,
      idleTimeoutMs: IDLE_MS,
      absoluteTimeoutMs: ABSOLUTE_MS,
      ...overrides,
    },
    at(T0),
  ).session;

// --- opening -------------------------------------------------------------------

describe('openSession — grant with injected clock', () => {
  it('opens an active session stamped at the clock instant', () => {
    const session = open();
    expect(session.status).toBe('active');
    expect(session.createdAt.toISOString()).toBe(T0);
    expect(session.lastSeenAt.toISOString()).toBe(T0);
    expect(session.endedAt).toBeNull();
  });

  it('timeout validation table — safe positive integers only', () => {
    expectCode(() => open({ idleTimeoutMs: 0 }), 'SESS_TIMEOUT_INVALID');
    expectCode(() => open({ idleTimeoutMs: -1 }), 'SESS_TIMEOUT_INVALID');
    expectCode(() => open({ idleTimeoutMs: 1.5 }), 'SESS_TIMEOUT_INVALID');
    expectCode(() => open({ absoluteTimeoutMs: 0 }), 'SESS_TIMEOUT_INVALID');
    expectCode(() => open({ absoluteTimeoutMs: Number.NaN }), 'SESS_TIMEOUT_INVALID');
  });

  it('a broken injected clock is refused', () => {
    expectCode(
      () =>
        openSession(
          { sessionId: SESSION, userId: USER, orgId: ORG, idleTimeoutMs: IDLE_MS, absoluteTimeoutMs: ABSOLUTE_MS },
          { now: () => new Date('nope') },
        ),
      'AUTH_CLOCK_INVALID',
    );
  });

  it('an idle window larger than the absolute cap is legal — the absolute cap wins by evaluation', () => {
    const session = open({ idleTimeoutMs: ABSOLUTE_MS * 2 });
    expect(sessionState(session, at(plus(T0, ABSOLUTE_MS)))).toBe('absoluteExpired');
  });
});

// --- the evaluator ------------------------------------------------------------------

describe('sessionState — precedence and inclusive boundaries (±1ms)', () => {
  it('terminal statuses win before any horizon arithmetic', () => {
    const expired: Session = { ...open(), status: 'expired' };
    expect(sessionState(expired, at(T0))).toBe('expired');
    const ended: Session = { ...open(), status: 'ended' };
    expect(sessionState(ended, at(T0))).toBe('ended');
    const revoked: Session = { ...open(), status: 'revoked' };
    expect(sessionState(revoked, at(T0))).toBe('revoked');
  });

  it('absolute horizon outranks the idle horizon', () => {
    const session = open({ idleTimeoutMs: ABSOLUTE_MS * 2, absoluteTimeoutMs: 60 * 1000 });
    // one instant past both horizons — the absolute reason must be reported
    expect(sessionState(session, at(plus(T0, 60 * 1000 + 1)))).toBe('absoluteExpired');
  });

  it('idle boundary is inclusive: expired at exactly the horizon, active 1ms before', () => {
    const session = open();
    expect(sessionState(session, at(plus(T0, IDLE_MS - 1)))).toBe('active');
    expect(sessionState(session, at(plus(T0, IDLE_MS)))).toBe('idleExpired');
  });

  it('absolute boundary is inclusive: expired at exactly the cap, active 1ms before', () => {
    // idle window longer than the lifetime cap so only the absolute horizon can fire
    const session = open({ idleTimeoutMs: ABSOLUTE_MS * 2 });
    expect(sessionState(session, at(plus(T0, ABSOLUTE_MS - 1)))).toBe('active');
    expect(sessionState(session, at(plus(T0, ABSOLUTE_MS)))).toBe('absoluteExpired');
  });

  it('activity refreshes the idle window: touched session survives past its original horizon', () => {
    const at10min = plus(T0, 10 * 60 * 1000);
    const touched = touchSession(open(), at(at10min)).session;
    // original idle horizon was T0+30min; the touch moved it to T0+40min
    expect(sessionState(touched, at(plus(T0, 35 * 60 * 1000)))).toBe('active');
    expect(sessionState(touched, at(plus(at10min, IDLE_MS - 1)))).toBe('active');
    expect(sessionState(touched, at(plus(at10min, IDLE_MS)))).toBe('idleExpired');
  });
});

// --- lifecycle -------------------------------------------------------------------------

describe('touch / end / revoke — only a live session transitions', () => {
  it('touch stamps a fresh lastSeenAt on an active session', () => {
    const t = plus(T0, 5 * 60 * 1000);
    const { session } = touchSession(open(), at(t));
    expect(session.lastSeenAt.toISOString()).toBe(t);
    expect(session.status).toBe('active');
  });

  it('a touch cannot resurrect an expired session', () => {
    const dead = open();
    const pastIdle = plus(T0, IDLE_MS + 1);
    expectCode(() => touchSession(dead, at(pastIdle)), 'SESS_NOT_ACTIVE');
  });

  it('endSession — explicit logout stamps endedAt/endedReason', () => {
    const t = plus(T0, 60 * 1000);
    const { session } = endSession(open(), { reason: 'user logout' }, at(t));
    expect(session.status).toBe('ended');
    expect(session.endedAt?.toISOString()).toBe(t);
    expect(session.endedReason).toBe('user logout');
  });

  it('endSession refuses an already-expired session (use the sweeper for what it is)', () => {
    const session = open();
    const pastIdle = plus(T0, IDLE_MS + 1);
    expectCode(() => endSession(session, { reason: 'logout' }, at(pastIdle)), 'SESS_NOT_ACTIVE');
  });

  it('revokeSession — hard kill is distinct from logout', () => {
    const t = plus(T0, 60 * 1000);
    const { session } = revokeSession(open(), { reason: 'admin kill' }, at(t));
    expect(session.status).toBe('revoked');
    expect(session.endedReason).toBe('admin kill');
  });

  it('reason/actor validation and clock guards', () => {
    expectCode(() => endSession(open(), { reason: '  ' }, at(T0)), 'AUTH_REASON_REQUIRED');
    expectCode(() => revokeSession(open(), { reason: '' }, at(T0)), 'AUTH_REASON_REQUIRED');
  });
});

// --- the sweeper ------------------------------------------------------------------------

describe('expireSession — sweeper emits auth.sessionExpired', () => {
  it('idle expiry: emits the event with reason idle', () => {
    const { session, event } = expireSession(open(), at(plus(T0, IDLE_MS + 1)));
    expect(session.status).toBe('expired');
    expect(session.endedReason).toBe('idle');
    expect(event.name).toBe('auth.sessionExpired');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(SESSION);
    expect(event.payload).toEqual({
      sessionId: SESSION,
      userId: USER,
      orgId: ORG,
      reason: 'idle',
      expiredAt: plus(T0, IDLE_MS + 1),
    });
  });

  it('absolute expiry: emits the event with reason absolute', () => {
    const { session, event } = expireSession(open(), at(plus(T0, ABSOLUTE_MS)));
    expect(session.endedReason).toBe('absolute');
    expect(event.payload.reason).toBe('absolute');
  });

  it('refuses to sweep a still-active session and to re-sweep a terminal one', () => {
    expectCode(() => expireSession(open(), at(plus(T0, IDLE_MS - 1))), 'SESS_NOT_DUE');
    const { session } = expireSession(open(), at(plus(T0, IDLE_MS + 1)));
    expectCode(() => expireSession(session, at(plus(T0, IDLE_MS + 2))), 'SESS_NOT_ACTIVE');
    const ended = endSession(open(), { reason: 'logout' }, at(T0)).session;
    expectCode(() => expireSession(ended, at(plus(T0, IDLE_MS + 1))), 'SESS_NOT_ACTIVE');
  });
});

// --- the suspension cascade -----------------------------------------------------------------

describe('revokeSessionsForUser — suspension cascade (session half)', () => {
  it('revokes every LIVE session of the user and returns them; others untouched', () => {
    const live = open({ sessionId: uid(320) }); // idle 30min — live at the sweep
    const otherUserLive = open({ sessionId: uid(321), userId: OTHER_USER });
    const alreadyEnded = endSession(open({ sessionId: uid(322) }), { reason: 'logout' }, at(T0)).session;
    const idleDead = open({ sessionId: uid(323), idleTimeoutMs: 60 * 1000 }); // idle-expired at the sweep
    const sweepAt = plus(T0, 10 * 60 * 1000); // inside live's idle window, past idleDead's

    const result = revokeSessionsForUser(
      [live, otherUserLive, alreadyEnded, idleDead],
      USER,
      { reason: 'owner suspended' },
      at(sweepAt),
    );

    expect(result.revoked.map((s) => s.sessionId)).toEqual([live.sessionId]);
    const byId = new Map(result.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get(live.sessionId)?.status).toBe('revoked');
    expect(byId.get(live.sessionId)?.endedReason).toBe('owner suspended');
    expect(byId.get(otherUserLive.sessionId)?.status).toBe('active'); // other user untouched
    expect(byId.get(alreadyEnded.sessionId)?.status).toBe('ended'); // terminal is final
    expect(byId.get(idleDead.sessionId)?.status).toBe('active'); // idle-expired: unusable already, no fact needed
  });

  it('never mutates the input array (no-mutation pin)', () => {
    const live = open();
    const input = [live];
    revokeSessionsForUser(input, USER, { reason: 'cascade' }, at(T0));
    const first = input[0] ?? null;
    expect(first).toBe(live);
    expect(first?.status).toBe('active');
  });

  it('validates the cascade reason', () => {
    expectCode(() => revokeSessionsForUser([open()], USER, { reason: ' ' }, at(T0)), 'AUTH_REASON_REQUIRED');
  });
});

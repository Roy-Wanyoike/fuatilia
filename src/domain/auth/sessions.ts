/**
 * Sessions — grant/expire lifecycle with injected clock (issue #46, SPEC §34
 * "Session management / Device & session management").
 *
 * Model:
 *   - a session carries BOTH an idle timeout (activity window from
 *     `lastSeenAt`) and an absolute timeout (lifetime cap from `createdAt`) —
 *     an endlessly-refreshing idle window can never outlive the absolute cap;
 *   - expiry is INCLUSIVE at the boundary: a session is usable only while
 *     `now < idleHorizon && now < absoluteHorizon` (same strictly-before
 *     convention as the payment-links lane, so ±1ms tests are meaningful);
 *   - status `active | ended | expired | revoked` — explicit logout (ended),
 *     sweeper expiry (expired, with `auth.sessionExpired`), and hard
 *     revocation (revoked — the suspension cascade / admin kill);
 *   - SUSPENSION CASCADE: `revokeSessionsForUser` retires every live session
 *     of a suspended user (suspendUser emits auth.userSuspended; this helper
 *     is the session half of the cascade — key denials are audited in
 *     apikeys.authenticateKey via ownerStatus).
 *
 * Session OPEN carries no catalog event (the issue's event list has
 * auth.sessionExpired only — the grant is visible on the aggregate; documented
 * gap, README). `sessionState` is the pure evaluator used by the guard.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  authEvent,
  type AuthEvent,
  type SessionExpiryReason,
  type SessionExpiredPayload,
} from './events';
import { assertClockDate, assertNonBlank } from './user';

export type SessionStatus = 'active' | 'ended' | 'expired' | 'revoked';

/** The evaluated usability of a session at an instant (guard input). */
export type SessionState = SessionStatus | 'idleExpired' | 'absoluteExpired';

export interface Session {
  readonly sessionId: Uuid;
  readonly userId: Uuid;
  readonly orgId: Uuid;
  /** Activity window from lastSeenAt — safe positive integer milliseconds. */
  readonly idleTimeoutMs: number;
  /** Lifetime cap from createdAt — safe positive integer milliseconds. */
  readonly absoluteTimeoutMs: number;
  readonly status: SessionStatus;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly endedAt: Date | null;
  readonly endedReason: string | null;
}

export interface OpenSessionArgs {
  readonly sessionId: Uuid;
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
}

const assertTimeout = (ms: number, code: string, label: string): number => {
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new DomainError(code, `${label} must be a safe positive integer of milliseconds, got ${String(ms)}`, {
      [label]: ms,
    });
  }
  return ms;
};

/**
 * Open a session (grant). Validation:
 *   - SESS_TIMEOUT_INVALID — non-integer/non-positive idle or absolute timeout;
 *   - AUTH_CLOCK_INVALID — broken injected clock.
 * The idle window may exceed the absolute one — the absolute cap wins by
 * construction (sessionState checks it first).
 */
export function openSession(args: OpenSessionArgs, clock: Clock): { session: Session } {
  const idleTimeoutMs = assertTimeout(args.idleTimeoutMs, 'SESS_TIMEOUT_INVALID', 'idleTimeoutMs');
  const absoluteTimeoutMs = assertTimeout(
    args.absoluteTimeoutMs,
    'SESS_TIMEOUT_INVALID',
    'absoluteTimeoutMs',
  );
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return {
    session: {
      sessionId: args.sessionId,
      userId: args.userId,
      orgId: args.orgId,
      idleTimeoutMs,
      absoluteTimeoutMs,
      status: 'active',
      createdAt: now,
      lastSeenAt: now,
      endedAt: null,
      endedReason: null,
    },
  };
}

/**
 * Evaluate a session at `clock.now()`. Precedence (deterministic): explicit
 * terminal statuses first, then the ABSOLUTE horizon, then the idle horizon,
 * then active. Inclusive boundaries: at exactly a horizon the session is
 * already expired (usable ⇔ now < horizon).
 */
export function sessionState(session: Session, clock: Clock): SessionState {
  if (session.status === 'ended') return 'ended';
  if (session.status === 'revoked') return 'revoked';
  if (session.status === 'expired') return 'expired';
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  const absoluteHorizon = session.createdAt.getTime() + session.absoluteTimeoutMs;
  if (now.getTime() >= absoluteHorizon) return 'absoluteExpired';
  const idleHorizon = session.lastSeenAt.getTime() + session.idleTimeoutMs;
  if (now.getTime() >= idleHorizon) return 'idleExpired';
  return 'active';
}

/**
 * Record activity: stamp `lastSeenAt` (fresh copy). Legal only while the
 * session evaluates ACTIVE — a touch cannot resurrect an idle-expired or
 * lifetime-expired session (SESS_NOT_ACTIVE).
 */
export function touchSession(session: Session, clock: Clock): { session: Session } {
  if (sessionState(session, clock) !== 'active') {
    throw new DomainError(
      'SESS_NOT_ACTIVE',
      `session ${session.sessionId} is not active — expired sessions cannot be touched`,
      { sessionId: session.sessionId, state: sessionState(session, clock) },
    );
  }
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { session: { ...session, lastSeenAt: now } };
}

/**
 * Explicit logout (active → ended). A session that already expired on its
 * own cannot be "ended" (SESS_NOT_ACTIVE); end it as what it is via the
 * sweeper instead.
 */
export function endSession(session: Session, args: { reason: string }, clock: Clock): { session: Session } {
  const reason = assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'logout reason');
  if (sessionState(session, clock) !== 'active') {
    throw new DomainError(
      'SESS_NOT_ACTIVE',
      `session ${session.sessionId} is not active — only a live session can be ended`,
      { sessionId: session.sessionId, state: sessionState(session, clock) },
    );
  }
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { session: { ...session, status: 'ended', endedAt: now, endedReason: reason } };
}

/**
 * Hard-revoke a session (admin kill / suspension cascade) — active → revoked.
 * Distinct from logout so audits can tell "user left" from "access was cut".
 */
export function revokeSession(
  session: Session,
  args: { reason: string },
  clock: Clock,
): { session: Session } {
  const reason = assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'revocation reason');
  if (sessionState(session, clock) !== 'active') {
    throw new DomainError(
      'SESS_NOT_ACTIVE',
      `session ${session.sessionId} is not active — only a live session can be revoked`,
      { sessionId: session.sessionId, state: sessionState(session, clock) },
    );
  }
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { session: { ...session, status: 'revoked', endedAt: now, endedReason: reason } };
}

/**
 * The sweeper: retire a session whose idle or absolute horizon has passed.
 * Emits `auth.sessionExpired` with the evaluated reason ('idle' | 'absolute')
 * — the audit fact that the session is gone.
 *
 * Throws:
 *   - SESS_NOT_DUE — the session still evaluates active (nothing to sweep);
 *   - SESS_NOT_ACTIVE — already ended/revoked/expired (terminals are final).
 */
export function expireSession(
  session: Session,
  clock: Clock,
): { session: Session; event: AuthEvent<'auth.sessionExpired', SessionExpiredPayload> } {
  const state = sessionState(session, clock);
  if (state === 'active') {
    throw new DomainError(
      'SESS_NOT_DUE',
      `session ${session.sessionId} has not reached its idle or absolute horizon yet`,
      { sessionId: session.sessionId, state },
    );
  }
  if (state !== 'idleExpired' && state !== 'absoluteExpired') {
    throw new DomainError(
      'SESS_NOT_ACTIVE',
      `session ${session.sessionId} is already ${state} — terminals are final`,
      { sessionId: session.sessionId, state },
    );
  }
  const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  const reason: SessionExpiryReason = state === 'idleExpired' ? 'idle' : 'absolute';
  const expired: Session = { ...session, status: 'expired', endedAt: now, endedReason: reason };
  const payload: SessionExpiredPayload = {
    sessionId: session.sessionId,
    userId: session.userId,
    orgId: session.orgId,
    reason,
    expiredAt: now.toISOString(),
  };
  return { session: expired, event: authEvent('auth.sessionExpired', session.sessionId, payload, clock) };
}

/**
 * The suspension cascade's session half: revoke every LIVE session of the
 * user (status active AND evaluating active — an idle-expired session is
 * already unusable and needs no revocation fact). Returns fresh copies; the
 * input array is never mutated. No catalog event here — the cascade is
 * evidenced by auth.userSuspended + each session's revoked status.
 */
export function revokeSessionsForUser(
  sessions: readonly Session[],
  userId: Uuid,
  args: { reason: string },
  clock: Clock,
): { sessions: Session[]; revoked: Session[] } {
  const reason = assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'cascade reason');
  assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  const revoked: Session[] = [];
  const sessions2 = sessions.map((s) => {
    if (s.userId !== userId) return s;
    if (s.status !== 'active' || sessionState(s, clock) !== 'active') return s;
    const now = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
    const killed: Session = { ...s, status: 'revoked', endedAt: now, endedReason: reason };
    revoked.push(killed);
    return killed;
  });
  return { sessions: sessions2, revoked };
}

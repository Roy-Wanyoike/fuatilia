/**
 * Wire-idempotency tests (issue #127): first-call-wins, crash-replay, the
 * concurrent follower refusal, and the lease reclaim — the idempotent-replay
 * leg of the AC2 table. No network, injectable clock.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import {
  emailDispatchKey,
  inMemoryEmailDispatchStore,
  withWireIdempotency,
} from './idempotency';
import type { EmailTransport, EmailWireRequest, EmailWireResult } from './transports';

const accepted: EmailWireResult = { ok: true, providerRef: '<m-1.1.1@relay.example>' };
const REQ: EmailWireRequest = {
  to: 'jane.doe@example.com',
  subject: 'Payment reminder',
  text: 'Invoice INV-1042 is due.',
  clientRef: 'm-1#1',
};

const counting = (results: readonly EmailWireResult[]) => {
  let calls = 0;
  const transport: EmailTransport = {
    name: 'smtp',
    async dispatch() {
      const result = results[Math.min(calls, results.length - 1)] as EmailWireResult;
      calls += 1;
      return result;
    },
  };
  return { transport, count: () => calls };
};

describe('emailDispatchKey', () => {
  it('composes per-attempt keys scoped by recipient', () => {
    expect(emailDispatchKey(REQ, 'm-1#1')).toBe('email:jane.doe@example.com:m-1:1');
    expect(emailDispatchKey(REQ, 'm-1#2')).toBe('email:jane.doe@example.com:m-1:2');
  });
  it('refuses unkeyable client refs', () => {
    expect(() => emailDispatchKey(REQ, 'no-attempt')).toThrowError(DomainError);
    expect(() => emailDispatchKey(REQ, 'm-1#0')).toThrowError(DomainError);
  });
});

describe('withWireIdempotency', () => {
  it('refuses an unkeyable dispatch before any I/O', async () => {
    const { transport, count } = counting([accepted]);
    const wrapped = withWireIdempotency(transport, inMemoryEmailDispatchStore());
    await expect(wrapped.dispatch({ ...REQ, clientRef: '   ' })).rejects.toThrowError(/cannot be made idempotent/);
    expect(count()).toBe(0);
  });

  it('replays the recorded result instead of re-charging the wire (idempotent replay)', async () => {
    const { transport, count } = counting([accepted]);
    const store = inMemoryEmailDispatchStore();
    const wrapped = withWireIdempotency(transport, store);
    const first = await wrapped.dispatch(REQ);
    const replay = await wrapped.dispatch(REQ);
    expect(first).toEqual(accepted);
    expect(replay).toEqual(accepted);
    expect(count()).toBe(1); // ONE provider call for the same key — same Message-ID back
  });

  it('replays recorded REFUSALS too (a retry of the same key never re-sends)', async () => {
    const refused: EmailWireResult = { ok: false, failureReason: 'EMAIL_SMTP_550: User unknown', retryable: false };
    const { transport, count } = counting([refused]);
    const wrapped = withWireIdempotency(transport, inMemoryEmailDispatchStore());
    const first = await wrapped.dispatch(REQ);
    const replay = await wrapped.dispatch(REQ);
    expect(first).toEqual(refused);
    expect(replay).toEqual(refused);
    expect(count()).toBe(1);
  });

  it('a concurrent follower is refused while the winner is in flight', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: EmailTransport = {
      name: 'smtp',
      async dispatch() {
        await gate;
        return accepted;
      },
    };
    const wrapped = withWireIdempotency(slow, inMemoryEmailDispatchStore());
    const lead = wrapped.dispatch(REQ);
    await expect(wrapped.dispatch(REQ)).rejects.toThrowError(/is in flight/);
    (release as unknown as () => void)();
    await expect(lead).resolves.toEqual(accepted);
  });

  it('a crash before recording leaves a placeholder that the LEASE reclaims', async () => {
    let now = 1_000_000;
    const store = inMemoryEmailDispatchStore({ now: () => now, leaseMs: 60_000 });
    const crashing: EmailTransport = {
      name: 'smtp',
      async dispatch() {
        throw new Error('worker died mid-flight'); // record() never runs
      },
    };
    const wrapped = withWireIdempotency(crashing, store);
    await expect(wrapped.dispatch(REQ)).rejects.toThrowError(/worker died/);

    // Still inside the lease: the follower is refused, not re-charged blindly.
    await expect(wrapped.dispatch(REQ)).rejects.toThrowError(/is in flight/);

    // After the lease expires the placeholder is reclaimable and the retry succeeds.
    now += 61_000;
    const { transport, count } = counting([accepted]);
    const recovered = withWireIdempotency(transport, store);
    await expect(recovered.dispatch(REQ)).resolves.toEqual(accepted);
    expect(count()).toBe(1);
  });

  it('different attempts of the same message are independent keys', async () => {
    const { transport, count } = counting([accepted, accepted]);
    const wrapped = withWireIdempotency(transport, inMemoryEmailDispatchStore());
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#1' });
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#2' });
    expect(count()).toBe(2);
  });
});

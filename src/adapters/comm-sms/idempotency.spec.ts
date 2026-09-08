/**
 * Wire-idempotency tests (issue #112): first-call-wins, crash-replay, the
 * concurrent follower refusal, and the lease reclaim. No network, injectable
 * clock.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import {
  inMemorySmsDispatchStore,
  smsDispatchKey,
  withWireIdempotency,
} from './idempotency';
import type { SmsTransport, SmsWireRequest, SmsWireResult } from './transports';

const accepted: SmsWireResult = { ok: true, providerRef: 'ATIdx_1' };
const REQ: SmsWireRequest & { clientRef: string } = { to: '254712345678', body: 'x', clientRef: 'm-1#1' };

const counting = (results: readonly SmsWireResult[]) => {
  let calls = 0;
  const transport: SmsTransport = {
    name: 'africastalking',
    async dispatch() {
      const result = results[Math.min(calls, results.length - 1)] as SmsWireResult;
      calls += 1;
      return result;
    },
  };
  return { transport, count: () => calls };
};

describe('smsDispatchKey', () => {
  it('composes per-attempt keys', () => {
    expect(smsDispatchKey(REQ, 'm-1#1')).toBe('sms:254712345678:m-1:1');
    expect(smsDispatchKey(REQ, 'm-1#2')).toBe('sms:254712345678:m-1:2');
  });
  it('refuses unkeyable client refs', () => {
    expect(() => smsDispatchKey(REQ, 'no-attempt')).toThrowError(DomainError);
    expect(() => smsDispatchKey(REQ, 'm-1#0')).toThrowError(DomainError);
  });
});

describe('withWireIdempotency', () => {
  it('refuses an unkeyed dispatch before any I/O', async () => {
    const { transport, count } = counting([accepted]);
    const wrapped = withWireIdempotency(transport, inMemorySmsDispatchStore());
    await expect(wrapped.dispatch({ to: '254712345678', body: 'x' })).rejects.toThrowError(/cannot be made idempotent/);
    expect(count()).toBe(0);
  });

  it('replays the recorded result instead of re-charging the wire', async () => {
    const { transport, count } = counting([accepted]);
    const store = inMemorySmsDispatchStore();
    const wrapped = withWireIdempotency(transport, store);
    const first = await wrapped.dispatch(REQ);
    const replay = await wrapped.dispatch(REQ);
    expect(first).toEqual(accepted);
    expect(replay).toEqual(accepted);
    expect(count()).toBe(1); // ONE provider call for the same key
  });

  it('a concurrent follower is refused while the winner is in flight', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: SmsTransport = {
      name: 'africastalking',
      async dispatch() {
        await gate;
        return accepted;
      },
    };
    const wrapped = withWireIdempotency(slow, inMemorySmsDispatchStore());
    const lead = wrapped.dispatch(REQ);
    await expect(wrapped.dispatch(REQ)).rejects.toThrowError(/is in flight/);
    (release as unknown as () => void)();
    await expect(lead).resolves.toEqual(accepted);
  });

  it('a crash before recording leaves a placeholder that the LEASE reclaims', async () => {
    let now = 1_000_000;
    const store = inMemorySmsDispatchStore({ now: () => now, leaseMs: 60_000 });
    const crashing: SmsTransport = {
      name: 'africastalking',
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
    const wrapped = withWireIdempotency(transport, inMemorySmsDispatchStore());
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#1' });
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#2' });
    expect(count()).toBe(2);
  });
});

describe('policyForWireResult', () => {
  it('permanent refusals collapse the ladder to one attempt', async () => {
    const { policyForWireResult } = await import('./provider');
    const standard = { maxAttempts: 3, backoffStepsMs: [1000, 5000] };
    const permanent = policyForWireResult({ ok: false, failureReason: 'AT_InvalidPhoneNumber', retryable: false }, standard);
    expect(permanent.maxAttempts).toBe(1);
    const retryable = policyForWireResult({ ok: false, failureReason: 'AT_RATE_LIMITED', retryable: true }, standard);
    expect(retryable.maxAttempts).toBe(3);
    const acceptedResult = policyForWireResult({ ok: true, providerRef: 'x' }, standard);
    expect(acceptedResult.maxAttempts).toBe(3);
  });
});

/**
 * Wire-idempotency tests (issue #128): first-call-wins, idempotent replay,
 * the concurrent follower refusal, the lease reclaim, and E.164-canonical
 * keys. No network, injectable clock.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import {
  inMemoryWhatsAppDispatchStore,
  whatsappDispatchKey,
  withWireIdempotency,
} from './idempotency';
import type { WhatsAppTemplateSend, WhatsAppTransport, WhatsAppWireResult } from './transports';

const accepted: WhatsAppWireResult = { ok: true, providerRef: 'wamid.ACBO' };
const REQ: WhatsAppTemplateSend & { clientRef: string } = {
  to: '+254712345678',
  templateName: 'payment_reminder_v1',
  languageCode: 'sw',
  bodyParams: ['INV-1042'],
  clientRef: 'm-1#1',
};

const counting = (results: readonly WhatsAppWireResult[]) => {
  let calls = 0;
  const transport: WhatsAppTransport = {
    name: 'whatsapp',
    async dispatch() {
      const result = results[Math.min(calls, results.length - 1)] as WhatsAppWireResult;
      calls += 1;
      return result;
    },
  };
  return { transport, count: () => calls };
};

describe('whatsappDispatchKey', () => {
  it('composes per-attempt keys over the normalized wa_id', () => {
    expect(whatsappDispatchKey(REQ, 'm-1#1')).toBe('wa:254712345678:m-1:1');
    expect(whatsappDispatchKey(REQ, 'm-1#2')).toBe('wa:254712345678:m-1:2');
  });

  it('the same phone in different input formats replays to the SAME key', () => {
    expect(whatsappDispatchKey({ ...REQ, to: '0712345678' }, 'm-1#1')).toBe('wa:254712345678:m-1:1');
    expect(whatsappDispatchKey({ ...REQ, to: '254-712-345-678' }, 'm-1#1')).toBe('wa:254712345678:m-1:1');
  });

  it('refuses unkeyable client refs', () => {
    expect(() => whatsappDispatchKey(REQ, 'no-attempt')).toThrowError(DomainError);
    expect(() => whatsappDispatchKey(REQ, 'm-1#0')).toThrowError(DomainError);
  });

  it('refuses unfixable phones BEFORE a key (and therefore a claim) exists', () => {
    expect(() => whatsappDispatchKey({ ...REQ, to: '441234567890' }, 'm-1#1')).toThrowError(DomainError);
  });
});

describe('withWireIdempotency', () => {
  it('refuses an unkeyed dispatch before any I/O', async () => {
    const { transport, count } = counting([accepted]);
    const wrapped = withWireIdempotency(transport, inMemoryWhatsAppDispatchStore());
    await expect(
      wrapped.dispatch({ ...REQ, clientRef: undefined }),
    ).rejects.toThrowError(/cannot be made idempotent/);
    expect(count()).toBe(0);
  });

  it('replays the recorded result instead of re-charging the wire (idempotent replay)', async () => {
    const { transport, count } = counting([accepted]);
    const store = inMemoryWhatsAppDispatchStore();
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
    const slow: WhatsAppTransport = {
      name: 'whatsapp',
      async dispatch() {
        await gate;
        return accepted;
      },
    };
    const wrapped = withWireIdempotency(slow, inMemoryWhatsAppDispatchStore());
    const lead = wrapped.dispatch(REQ);
    await expect(wrapped.dispatch(REQ)).rejects.toThrowError(/is in flight/);
    (release as unknown as () => void)();
    await expect(lead).resolves.toEqual(accepted);
  });

  it('a crash before recording leaves a placeholder that the LEASE reclaims', async () => {
    let now = 1_000_000;
    const store = inMemoryWhatsAppDispatchStore({ now: () => now, leaseMs: 60_000 });
    const crashing: WhatsAppTransport = {
      name: 'whatsapp',
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
    const wrapped = withWireIdempotency(transport, inMemoryWhatsAppDispatchStore());
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#1' });
    await wrapped.dispatch({ ...REQ, clientRef: 'm-1#2' });
    expect(count()).toBe(2);
  });

  it('a recorded FAILURE is replayed faithfully — the refusal is a fact too', async () => {
    const templateRejected: WhatsAppWireResult = { ok: false, failureReason: 'WA_TEMPLATE_REJECTED', retryable: false };
    const { transport, count } = counting([templateRejected]);
    const wrapped = withWireIdempotency(transport, inMemoryWhatsAppDispatchStore());
    const first = await wrapped.dispatch(REQ);
    const replay = await wrapped.dispatch(REQ);
    expect(first).toEqual(templateRejected);
    expect(replay).toEqual(templateRejected);
    expect(count()).toBe(1);
  });
});

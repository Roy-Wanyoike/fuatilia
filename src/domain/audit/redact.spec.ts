import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import {
  FORBIDDEN_KEYS,
  MAX_SNAPSHOT_DEPTH,
  redactSnapshot,
  validateSnapshotShape,
} from './redact';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- stripping tables -----------------------------------------------------------------

describe('redactSnapshot — forbidden keys are stripped case-insensitively (SPEC §37)', () => {
  it.each(FORBIDDEN_KEYS)('strips the forbidden key "%s" at the top level', (word) => {
    const out = redactSnapshot<Record<string, unknown>>({ [word]: 'boom', keep: 'yes' });
    expect(out).toEqual({ keep: 'yes' });
  });

  it('strips every casing variant (bypass-by-capitalisation is impossible)', () => {
    const out = redactSnapshot<Record<string, unknown>>({
      PASSWORD: 'a',
      Password: 'b',
      SeCrEt: 'c',
      TOKEN: 'd',
      ApiKey: 'e',
      APIKEY: 'f',
      Authorization: 'g',
      pIn: 'h',
      keep: 1,
    });
    expect(out).toEqual({ keep: 1 });
  });

  it('strips containment matches — credentials hide behind prefixes and separators', () => {
    const out = redactSnapshot<Record<string, unknown>>({
      client_secret: 'a',
      access_token: 'b',
      api_key: 'c',
      secretToken: 'd',
      PIN_code: 'e',
      darajaAuthorizationHeader: 'f',
      keepMe: 'g',
    });
    expect(out).toEqual({ keepMe: 'g' });
  });

  it('a benign near-miss survives, a plural of a forbidden word does not (containment, not vibes)', () => {
    const out = redactSnapshot<Record<string, unknown>>({ passwd: 'x', tokens: 0 });
    expect(out).toEqual({ passwd: 'x' }); // 'passwd' contains no forbidden word; 'tokens' contains 'token'
  });

  it('strips recursively through nested objects (depth ≥ 3)', () => {
    const out = redactSnapshot<Record<string, unknown>>({
      level1: { level2: { level3: { password: 'boom', amountMinor: 500 } } },
    });
    expect(out).toEqual({ level1: { level2: { level3: { amountMinor: 500 } } } });
  });

  it('strips through nested arrays of objects, and array order survives', () => {
    const out = redactSnapshot<Record<string, unknown>>({
      payments: [
        { id: 'p1', token: 't1' },
        { id: 'p2', meta: { apiKey: 'k2', ok: true } },
        'scalar',
        42,
      ],
    });
    expect(out).toEqual({ payments: [{ id: 'p1' }, { id: 'p2', meta: { ok: true } }, 'scalar', 42] });
  });

  it('an object that becomes empty still exists (stripped, not erased)', () => {
    const out = redactSnapshot<Record<string, unknown>>({ credentials: { secret: 'x' }, outer: { keep: 1 } });
    expect(out).toEqual({ credentials: {}, outer: { keep: 1 } });
  });
});

// --- purity: non-destructive in, frozen out -------------------------------------------------

describe('redactSnapshot — inputs non-destructive, outputs deep-frozen', () => {
  it('never mutates its input (deep-checked, nested arrays included)', () => {
    const input = {
      password: 'original-secret-value',
      nested: { token: 'original-token-value', items: [{ apiKey: 'k' }] },
      keep: 'yes',
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactSnapshot(input);
    expect(input).toEqual(snapshot); // deep-equal to its pre-call self
    expect((input.nested as { token: string }).token).toBe('original-token-value');
  });

  it('returns a fresh copy — output is not the input, even with nothing to strip', () => {
    const input = { a: 1 };
    const out = redactSnapshot(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('the output is deep-frozen at every level', () => {
    const out = redactSnapshot<Record<string, unknown>>({ a: { b: { c: [1, { d: 2 }] } } });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.a)).toBe(true);
    expect(Object.isFrozen((out.a as { b: object }).b)).toBe(true);
    expect(Object.isFrozen((out.a as { b: { c: unknown[] } }).b.c)).toBe(true);
    expect(Object.isFrozen((out.a as { b: { c: { d: number }[] } }).b.c[1])).toBe(true);
  });

  it('a mutation attempt on the frozen output throws TypeError (ESM strict mode)', () => {
    const out = redactSnapshot<Record<string, unknown>>({ nested: { x: 1 } });
    expect(() => {
      (out.nested as { x: number }).x = 99;
    }).toThrow(TypeError);
  });

  it('redaction is idempotent — redact(redact(x)) deep-equals redact(x)', () => {
    const input = { password: 'x', list: [{ token: 'y', ok: 1 }] };
    const once = redactSnapshot(input);
    expect(redactSnapshot(once)).toEqual(once);
  });

  it('scalars pass through untouched (string / number / boolean / null)', () => {
    expect(redactSnapshot('status')).toBe('status');
    expect(redactSnapshot(7)).toBe(7);
    expect(redactSnapshot(true)).toBe(true);
    expect(redactSnapshot(null)).toBeNull();
  });
});

// --- structural refusals -----------------------------------------------------------------------

describe('redactSnapshot — structurally invalid snapshots are refused (AUDIT_SNAPSHOT_INVALID)', () => {
  it('refusal table', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expectCode(() => redactSnapshot(cyclic), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: undefined }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: Number.NaN }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: Number.POSITIVE_INFINITY }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: 1n }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: new Date('2026-03-01T08:00:00.000Z') }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => redactSnapshot({ bad: () => 1 }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => validateSnapshotShape([undefined]), 'AUDIT_SNAPSHOT_INVALID');
  });

  it(`nesting beyond ${MAX_SNAPSHOT_DEPTH} levels is refused — snapshots stay hashable`, () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i <= MAX_SNAPSHOT_DEPTH; i += 1) deep = { wrap: deep };
    expectCode(() => redactSnapshot(deep), 'AUDIT_SNAPSHOT_INVALID');
  });
});

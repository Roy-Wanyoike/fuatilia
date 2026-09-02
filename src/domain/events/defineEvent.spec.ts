import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import { defineEvent } from './defineEvent';
import { EVENT_NAMES } from './catalog';

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

describe('defineEvent — naming convention + catalog membership + version guard', () => {
  it('validates every one of the 27 catalog names and returns the frozen definition (version 1)', () => {
    for (const name of EVENT_NAMES) {
      const definition = defineEvent(name, 1);
      expect(definition).toEqual({ name, version: 1 });
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it.each([
    { name: 'invoice.paid' },
    { name: 'consent.granted' }, // wave-3 deferral — not in the core 27
    { name: 'collections.caseClosed' },
    { name: 'intelligence.priorityComputed' },
    { name: 'receivable.expired' },
  ])('unknown name $name → EVENT_UNKNOWN', ({ name }) => {
    expectCode(() => defineEvent(name, 1), 'EVENT_UNKNOWN');
  });

  it.each([
    { name: 'noDot' },
    { name: 'NoDot.either' },
    { name: 'receivable.Opened' },
    { name: 'a.b.c' },
    { name: 'receivable.opened.x' },
    { name: '' },
    { name: 'receivable.opened!' },
  ])('malformed name $name → EVENT_NAME_MALFORMED (checked before membership)', ({ name }) => {
    expectCode(() => defineEvent(name, 1), 'EVENT_NAME_MALFORMED');
  });

  it.each([
    { name: 'receivable.opened', version: 2, label: 'bumped to 2' },
    { name: 'receivable.opened', version: 0, label: 'zero' },
    { name: 'receivable.opened', version: -1, label: 'negative' },
    { name: 'receivable.opened', version: 1.5, label: 'fractional' },
    { name: 'payment.confirmed', version: Number.NaN, label: 'NaN' },
    { name: 'payment.confirmed', version: Number.POSITIVE_INFINITY, label: 'Infinity' },
  ])('version $label for $name → EVENT_VERSION_UNSUPPORTED (bumps are catalog changes, not call-site arguments)', ({ name, version }) => {
    expectCode(() => defineEvent(name, version), 'EVENT_VERSION_UNSUPPORTED');
  });

  it('refuses a non-number version (defensive — JS callers)', () => {
    expectCode(() => defineEvent('receivable.opened', '1' as unknown as number), 'EVENT_VERSION_UNSUPPORTED');
  });
});

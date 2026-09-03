import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import {
  WEBHOOK_EVENT_PREFIX_UNKNOWN,
  WEBHOOK_SUBSCRIPTION_MALFORMED,
  EVENT_TYPE_PATTERN,
  KNOWN_EVENT_PREFIXES,
  matchesSubscription,
  parseSubscriptionPattern,
} from './subscription';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

describe('parseSubscriptionPattern — the grammar', () => {
  it('accepts exact catalog event types as mode exact', () => {
    expect(parseSubscriptionPattern('payment.confirmed')).toEqual({
      pattern: 'payment.confirmed',
      mode: 'exact',
    });
  });

  it('accepts wildcards over KNOWN contexts only, as mode wildcard', () => {
    expect(parseSubscriptionPattern('payment.*')).toEqual({ pattern: 'payment.*', mode: 'wildcard' });
  });

  it('refuses wildcards over unknown contexts — a wildcard subscribing to nothing is a typo', () => {
    expectCode(() => parseSubscriptionPattern('unicorn.*'), WEBHOOK_EVENT_PREFIX_UNKNOWN);
    expectCode(() => parseSubscriptionPattern('webhooks.*'), WEBHOOK_EVENT_PREFIX_UNKNOWN);
  });

  it('refuses exact types over unknown contexts too', () => {
    expectCode(() => parseSubscriptionPattern('unicorn.sparkled'), WEBHOOK_EVENT_PREFIX_UNKNOWN);
  });

  it('malformed-pattern table', () => {
    expectCode(() => parseSubscriptionPattern(''), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('payment'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('payment.confirmed.extra'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('Payment.confirmed'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('payment.Confirmed'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('payment.confirmed*'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('*.confirmed'), WEBHOOK_SUBSCRIPTION_MALFORMED);
    expectCode(() => parseSubscriptionPattern('*'), WEBHOOK_SUBSCRIPTION_MALFORMED);
  });

  it('the known-context table is data drawn from the catalog vocabulary', () => {
    expect(KNOWN_EVENT_PREFIXES.length).toBeGreaterThanOrEqual(20);
    expect(KNOWN_EVENT_PREFIXES).toContain('payment');
    expect(KNOWN_EVENT_PREFIXES).toContain('collections');
    expect(KNOWN_EVENT_PREFIXES).toContain('policy');
    expect(KNOWN_EVENT_PREFIXES).toContain('nba');
  });

  it('catalog event types match the shape pattern', () => {
    expect(EVENT_TYPE_PATTERN.test('payment.confirmed')).toBe(true);
    expect(EVENT_TYPE_PATTERN.test('collections.dunningBlockedNoConsent')).toBe(true);
    expect(EVENT_TYPE_PATTERN.test('payment.confirmed.x')).toBe(false);
  });
});

describe('matchesSubscription — the total matcher (never throws)', () => {
  it('exact patterns compare for equality', () => {
    expect(matchesSubscription('payment.confirmed', 'payment.confirmed')).toBe(true);
    expect(matchesSubscription('payment.confirmed', 'payment.identified')).toBe(false);
  });

  it('wildcards match whole segments only — payment.* never matches payments.*', () => {
    expect(matchesSubscription('payment.*', 'payment.identified')).toBe(true);
    expect(matchesSubscription('payment.*', 'payment.confirmed')).toBe(true);
    expect(matchesSubscription('payment.*', 'payments.intakeConfirmed')).toBe(false);
    expect(matchesSubscription('payment.*', 'payment')).toBe(false);
  });

  it('malformed input on either side matches nothing', () => {
    expect(matchesSubscription('nonsense', 'payment.confirmed')).toBe(false);
    expect(matchesSubscription('payment.*', 'not an event type')).toBe(false);
    expect(matchesSubscription('', '')).toBe(false);
    expect(matchesSubscription('payment.*', 'payment.Confirmed')).toBe(false);
  });
});

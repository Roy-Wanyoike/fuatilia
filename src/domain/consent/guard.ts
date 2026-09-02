/**
 * Contact guard — the pure K2/K3 decision boundary (issue #10).
 *
 * `assertCanContact` answers one question: may we contact this customer on
 * this channel for this purpose right now? It is a pure DECISION function:
 *
 *   - an allowed decision carries the supporting ConsentGrant;
 *   - a refusal is a VALUE with a typed reason
 *     ('NO_GRANT' | 'REVOKED' | 'WRONG_PURPOSE' | 'WRONG_CHANNEL') — refusal
 *     is a valid outcome and never throws;
 *   - only invalid *input* (unknown channel/purpose, broken clock) throws a
 *     stable DomainError.
 *
 * K2 (Meta policy): WhatsApp dunning REQUIRES an active whatsapp/dunning
 * grant. There is no implied or inherited consent — a marketing grant, or a
 * dunning grant on sms/email, never unlocks WhatsApp dunning.
 *
 * Refusal precedence (deterministic, first match wins — documented so callers
 * can rely on the reason):
 *   1. REVOKED        — the exact (customer, channel, purpose) grant exists
 *                       but carries a revocation and no later re-grant is
 *                       active (K3 append-only trail);
 *   2. WRONG_CHANNEL  — an active grant exists for the same purpose on a
 *                       different channel;
 *   3. WRONG_PURPOSE  — an active grant exists on the same channel for a
 *                       different purpose (e.g. marketing ≠ dunning);
 *   4. NO_GRANT       — nothing in the registry supports this contact
 *                       (including grants only *pending* in the future).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  assertChannel,
  assertPurpose,
  isActiveAt,
  type ConsentChannel,
  type ConsentGrant,
  type ConsentPurpose,
} from './consent-grant';

export type RefusalReason = 'NO_GRANT' | 'REVOKED' | 'WRONG_PURPOSE' | 'WRONG_CHANNEL';

export type ContactDecision =
  | { readonly allowed: true; readonly grant: ConsentGrant }
  | { readonly allowed: false; readonly reason: RefusalReason; readonly detail: string };

export interface ContactRequest {
  readonly customerId: Uuid;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
}

const refusal = (reason: RefusalReason, detail: string): ContactDecision => ({
  allowed: false,
  reason,
  detail,
});

export function assertCanContact(
  grants: readonly ConsentGrant[],
  request: ContactRequest,
  clock: Clock,
): ContactDecision {
  // Invalid input throws; refusals do not.
  const channel = assertChannel(request.channel);
  const purpose = assertPurpose(request.purpose);
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new DomainError('CONSENT_CLOCK_INVALID', 'clock returned an invalid Date');
  }

  const mine = grants.filter((g) => g.customerId === request.customerId);
  const exact = mine.filter((g) => g.channel === channel && g.purpose === purpose);

  // Registry discipline (grantConsent) keeps at most one active grant per
  // triple; if an externally-assembled array ever carries several, the latest
  // grantedAt wins so the decision is independent of array order.
  const active = exact
    .filter((g) => isActiveAt(g, now))
    .reduce<ConsentGrant | null>(
      (best, g) => (best === null || g.grantedAt.getTime() >= best.grantedAt.getTime() ? g : best),
      null,
    );
  if (active) {
    return { allowed: true, grant: active };
  }

  // 1. Exact-triple trail shows a revocation and nothing active replaced it.
  if (exact.some((g) => g.revokedAt !== null)) {
    const lastRevokedAt = exact
      .filter((g) => g.revokedAt !== null)
      .map((g) => g.revokedAt as Date)
      .reduce((latest, at) => (at.getTime() > latest.getTime() ? at : latest));
    return refusal(
      'REVOKED',
      `${channel}/${purpose} consent for customer ${request.customerId} was revoked at ${lastRevokedAt.toISOString()}`,
    );
  }

  // 2. Same purpose, different channel.
  const otherChannel = mine.find(
    (g) => g.purpose === purpose && g.channel !== channel && isActiveAt(g, now),
  );
  if (otherChannel) {
    return refusal(
      'WRONG_CHANNEL',
      `active ${purpose} consent exists on ${otherChannel.channel}, not ${channel}`,
    );
  }

  // 3. Same channel, different purpose (marketing consent never implies dunning — K2).
  const otherPurpose = mine.find(
    (g) => g.channel === channel && g.purpose !== purpose && isActiveAt(g, now),
  );
  if (otherPurpose) {
    return refusal(
      'WRONG_PURPOSE',
      `active ${otherPurpose.purpose} consent on ${channel} does not cover ${purpose}`,
    );
  }

  // 4. Nothing supports this contact (none, all revoked elsewhere, or pending).
  const detail =
    mine.length === 0
      ? `no consent grants registered for customer ${request.customerId}`
      : `no active grant supports ${channel}/${purpose} for customer ${request.customerId}`;
  return refusal('NO_GRANT', detail);
}

/**
 * K2 gate convenience: the WhatsApp dunning check Collections must pass before
 * rendering any dunning step (`DunningStep.requiresConsent`). Thin over
 * assertCanContact so policy wording stays in one place.
 */
export const assertWhatsAppDunningAllowed = (
  grants: readonly ConsentGrant[],
  customerId: Uuid,
  clock: Clock,
): ContactDecision =>
  assertCanContact(grants, { customerId, channel: 'whatsapp', purpose: 'dunning' }, clock);

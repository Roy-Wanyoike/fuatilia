/**
 * ConsentGrant — the DPA 2019 lawful-basis record (issue #10, review findings
 * K2/K3, docs/05 data dictionary).
 *
 * One row is appended per consent event for a (customer, channel, purpose)
 * triple. The registry is append-only (R3 discipline applied to consent):
 *
 *   - `grantConsent` appends a NEW row and refuses when an active grant for the
 *     same triple already exists (CONSENT_ALREADY_ACTIVE).
 *   - `revokeConsent` never deletes or edits: it returns a new grant copy with
 *     `revokedAt` stamped from the injected Clock; the original row object is
 *     left untouched.
 *   - Contacting again after revocation means granting again → another new row.
 *     The (granted → revoked → granted) chain IS the audit trail (K3).
 *
 * Everything is pure: no I/O, no Date.now() — time only via the injected Clock.
 */
import { DomainError, type Clock, type Uuid } from '../shared';

export const CONSENT_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_PURPOSES = ['dunning', 'marketing'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export interface ConsentGrant {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly grantedAt: Date;
  /** Null while the grant is live; stamped by revokeConsent (append-only). */
  readonly revokedAt: Date | null;
}

// --- input validation (stable codes; shared with the guard) -----------------

export const assertChannel = (channel: string): ConsentChannel => {
  if (!(CONSENT_CHANNELS as readonly string[]).includes(channel)) {
    throw new DomainError('CONSENT_CHANNEL_INVALID', `unknown consent channel: ${channel}`, {
      channel,
      allowed: CONSENT_CHANNELS,
    });
  }
  return channel as ConsentChannel;
};

export const assertPurpose = (purpose: string): ConsentPurpose => {
  if (!(CONSENT_PURPOSES as readonly string[]).includes(purpose)) {
    throw new DomainError('CONSENT_PURPOSE_INVALID', `unknown consent purpose: ${purpose}`, {
      purpose,
      allowed: CONSENT_PURPOSES,
    });
  }
  return purpose as ConsentPurpose;
};

const assertClockDate = (at: Date, code: string): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'clock returned an invalid Date');
  }
  return at;
};

// --- registry operations -----------------------------------------------------

export interface GrantConsentArgs {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
}

/**
 * Append a new active grant for (customerId, channel, purpose).
 *
 * Throws (input/registry violations only — never for "already asked"):
 *   - CONSENT_CHANNEL_INVALID / CONSENT_PURPOSE_INVALID — malformed request;
 *   - CONSENT_GRANT_ID_TAKEN — the id already exists in the registry
 *     (protects the K3 audit trail from id collisions);
 *   - CONSENT_ALREADY_ACTIVE — an active grant for the same triple exists.
 *     Re-consenting after revocation is a NEW grant row, so this only fires
 *     when the previous grant is still live.
 */
export function grantConsent(
  args: GrantConsentArgs,
  existingGrants: readonly ConsentGrant[],
  clock: Clock,
): ConsentGrant {
  const channel = assertChannel(args.channel);
  const purpose = assertPurpose(args.purpose);
  const grantedAt = assertClockDate(clock.now(), 'CONSENT_CLOCK_INVALID');

  if (existingGrants.some((g) => g.id === args.id)) {
    throw new DomainError('CONSENT_GRANT_ID_TAKEN', `grant id already registered: ${args.id}`, {
      id: args.id,
    });
  }

  const active = existingGrants.find(
    (g) =>
      g.customerId === args.customerId &&
      g.channel === channel &&
      g.purpose === purpose &&
      isActiveAt(g, grantedAt),
  );
  if (active) {
    throw new DomainError(
      'CONSENT_ALREADY_ACTIVE',
      `active ${channel}/${purpose} grant already exists for customer ${args.customerId}`,
      { grantId: active.id, grantedAt: active.grantedAt.toISOString() },
    );
  }

  return { id: args.id, customerId: args.customerId, channel, purpose, grantedAt, revokedAt: null };
}

/**
 * Append-only revocation (K3): returns a NEW grant with `revokedAt` set from
 * the Clock. The input grant object is never mutated and must be kept in the
 * registry alongside the returned row.
 *
 * Throws CONSENT_ALREADY_REVOKED when the grant already carries a revocation.
 */
export function revokeConsent(grant: ConsentGrant, clock: Clock): ConsentGrant {
  if (grant.revokedAt !== null) {
    throw new DomainError(
      'CONSENT_ALREADY_REVOKED',
      `grant ${grant.id} was already revoked at ${grant.revokedAt.toISOString()}`,
      { grantId: grant.id, revokedAt: grant.revokedAt.toISOString() },
    );
  }
  const revokedAt = assertClockDate(clock.now(), 'CONSENT_CLOCK_INVALID');
  return { ...grant, revokedAt };
}

// --- time semantics -----------------------------------------------------------

/**
 * A grant is active at instant `at` iff consent was already given
 * (grantedAt <= at) and not withdrawn (revokedAt is null or strictly after
 * `at`). A grant revoked at the exact same instant it was granted is not
 * active — withdrawal wins ties.
 */
export const isActiveAt = (grant: ConsentGrant, at: Date): boolean =>
  grant.grantedAt.getTime() <= at.getTime() &&
  (grant.revokedAt === null || grant.revokedAt.getTime() > at.getTime());

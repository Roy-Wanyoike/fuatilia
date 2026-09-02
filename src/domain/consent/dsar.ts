/**
 * DSAR consent-trail projection (issue #10, review finding K3 — Data
 * Protection Act 2019 subject-access export).
 *
 * `consentTrail(grants, customerId)` folds the raw append-only registry rows
 * for one customer into the chronological story a data-subject request must
 * show: every grant, every revocation, and what is currently live. Pure — it
 * reads the array exactly as supplied (the caller decides what "now" means;
 * rows carry their own timestamps).
 */
import type { Uuid } from '../shared';
import type { ConsentChannel, ConsentGrant, ConsentPurpose } from './consent-grant';

/** One "consent was given" fact, in the order it happened. */
export interface ConsentGrantedEntry {
  readonly grantId: Uuid;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly grantedAt: Date;
}

/** One "consent was withdrawn" fact, in the order it happened. */
export interface ConsentRevokedEntry {
  readonly grantId: Uuid;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly revokedAt: Date;
}

export interface ConsentTrail {
  readonly customerId: Uuid;
  /** Every grant ever appended for this customer, oldest first. */
  readonly granted: readonly ConsentGrantedEntry[];
  /** Every revocation, oldest first (absent rows = never revoked). */
  readonly revoked: readonly ConsentRevokedEntry[];
  /** Grants still carrying lawful basis (revokedAt === null) as recorded. */
  readonly active: readonly ConsentGrant[];
}

const byTimeThenId = <T>(timeOf: (entry: T) => Date, idOf: (entry: T) => Uuid) => {
  return (a: T, b: T): number => {
    const delta = timeOf(a).getTime() - timeOf(b).getTime();
    if (delta !== 0) return delta;
    // Deterministic tie-break so equal timestamps never depend on input order.
    return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0;
  };
};

const byGranted = byTimeThenId<ConsentGrant>((g) => g.grantedAt, (g) => g.id);

/**
 * Build the DSAR export projection for one customer. Never mutates or filters
 * the input registry; other customers' rows are excluded.
 */
export function consentTrail(
  grants: readonly ConsentGrant[],
  customerId: Uuid,
): ConsentTrail {
  const mine = grants.filter((g) => g.customerId === customerId);

  const granted = [...mine]
    .sort(byGranted)
    .map<ConsentGrantedEntry>((g) => ({
      grantId: g.id,
      channel: g.channel,
      purpose: g.purpose,
      grantedAt: g.grantedAt,
    }));

  const revoked = mine
    .filter((g): g is ConsentGrant & { readonly revokedAt: Date } => g.revokedAt !== null)
    .sort(byTimeThenId((g) => g.revokedAt, (g) => g.id))
    .map<ConsentRevokedEntry>((g) => ({
      grantId: g.id,
      channel: g.channel,
      purpose: g.purpose,
      revokedAt: g.revokedAt,
    }));

  const active = mine.filter((g) => g.revokedAt === null).sort(byGranted);

  return { customerId, granted, revoked, active };
}

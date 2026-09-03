/**
 * Next-best-action candidate vocabulary (issue #36, VISION §3.4).
 *
 * The candidate set is FIXED and first-class: `do_nothing` is a real
 * candidate that can win. A uniform transparent expression scores every
 * candidate — expected-recovery proxy × channel fit − cost − fatigue — so
 * "do nothing" beats any action whose expected recovery does not cover its
 * cost and fatigue (small amounts, opted-out customers, saturated channels).
 *
 * `NBA_ACTIONS` doubles as the canonical tie-break order: when two
 * candidates tie on score, the one earlier in this list ranks first
 * (stable, documented — no insertion-order or hash-order surprises).
 */
import { DomainError } from '../shared';

export const NBA_ACTIONS = [
  'call',
  'whatsapp',
  'sms',
  'offer_payment_plan',
  'send_payment_link',
  'human_review',
  'escalate',
  'do_nothing',
] as const;
export type NbaActionType = (typeof NBA_ACTIONS)[number];

/** Actions that reach the customer (subject to channel fit + fatigue caps). */
export const NBA_CUSTOMER_FACING_ACTIONS = [
  'call',
  'whatsapp',
  'sms',
  'offer_payment_plan',
  'send_payment_link',
] as const;
export type NbaCustomerFacingAction = (typeof NBA_CUSTOMER_FACING_ACTIONS)[number];

/** Actions decided and executed inside the business (no customer contact). */
export const NBA_INTERNAL_ACTIONS = ['human_review', 'escalate', 'do_nothing'] as const;
export type NbaInternalAction = (typeof NBA_INTERNAL_ACTIONS)[number];

/** Contact channels the feature bundle carries preferences for. */
export const NBA_CONTACT_CHANNELS = ['call', 'whatsapp', 'sms'] as const;
export type NbaContactChannel = (typeof NBA_CONTACT_CHANNELS)[number];

/** The self-serve digital delivery channels offers/links can travel over. */
export const NBA_DIGITAL_DELIVERY_CHANNELS = ['whatsapp', 'sms'] as const;

export const assertNbaActionType = (action: string): NbaActionType => {
  if (!(NBA_ACTIONS as readonly string[]).includes(action)) {
    throw new DomainError('NBA_ACTION_INVALID', `unknown NBA action: ${String(action)}`, {
      action: String(action),
      allowed: NBA_ACTIONS,
    });
  }
  return action as NbaActionType;
};

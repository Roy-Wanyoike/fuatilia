/**
 * ActionRequest validation — table-driven two-tier contract (issue #34).
 *
 * Tier 1: MALFORMED input throws a stable POLICY_* DomainError (a bug, not a
 * governance outcome). Tier 2: an UNKNOWN action type is NOT malformed — it
 * is accepted here and GOVERNED (denied) by the engine, so garbage from a
 * misbehaving automation can never crash past the safety layer.
 */
import { describe, expect, it } from 'vitest';
import { DomainError, uuid, type Uuid } from '../shared';
import {
  ACTOR_TYPES,
  ACTION_TYPES,
  AMOUNT_REQUIRED_ACTION_TYPES,
  CHANNELS,
  CONTACT_ACTION_TYPES,
  IMPLIED_CHANNEL,
  RISK_CLASSES,
  assertActionRequest,
  effectiveChannel,
  type ActionRequest,
} from './request';

// --- fixtures -----------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);
const CASE = uid(4);

const baseRequest = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  orgId: ORG,
  customerId: CUSTOMER,
  receivableId: RECEIVABLE,
  caseId: null,
  actor: { type: 'ai_agent', actorId: 'agent-1' },
  actionType: 'send_whatsapp',
  amountMinor: null,
  currency: null,
  riskClass: 'low',
  channel: null,
  consentPresent: true,
  disputeOpen: false,
  promisePending: false,
  autonomous: true,
  ...over,
});

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the governed vocabularies ---------------------------------------------------

describe('policy request vocabularies', () => {
  it('exposes exactly the issue #34 action vocabulary', () => {
    expect([...ACTION_TYPES]).toEqual([
      'send_reminder',
      'send_whatsapp',
      'send_sms',
      'offer_payment_plan',
      'issue_payment_link',
      'escalate',
      'write_off',
      'refund',
    ]);
  });

  it('pins the actor types, risk classes and channels', () => {
    expect([...ACTOR_TYPES]).toEqual(['human', 'ai_agent', 'integration']);
    expect([...RISK_CLASSES]).toEqual(['low', 'elevated', 'high']);
    expect([...CHANNELS]).toEqual(['email', 'sms', 'whatsapp']);
  });

  it('pins the contact actions and the amount-required actions', () => {
    expect([...CONTACT_ACTION_TYPES]).toEqual(['send_reminder', 'send_whatsapp', 'send_sms']);
    expect([...AMOUNT_REQUIRED_ACTION_TYPES]).toEqual(['write_off', 'refund']);
  });

  it('pins the implied channels — only send_whatsapp/send_sms imply theirs', () => {
    expect(IMPLIED_CHANNEL).toEqual({ send_whatsapp: 'whatsapp', send_sms: 'sms' });
  });
});

// --- tier 1: malformed input throws ------------------------------------------------

describe('assertActionRequest — malformed input tables', () => {
  it('accepts a valid default request', () => {
    expect(() => assertActionRequest(baseRequest())).not.toThrow();
  });

  it.each([
    ['request itself is not an object', () => assertActionRequest(null as unknown as ActionRequest), 'POLICY_REQUEST_INVALID'],
    ['request is an array', () => assertActionRequest([] as unknown as ActionRequest), 'POLICY_REQUEST_INVALID'],
    ['blank orgId', () => assertActionRequest(baseRequest({ orgId: '  ' as Uuid })), 'POLICY_ORG_REQUIRED'],
    ['blank customerId', () => assertActionRequest(baseRequest({ customerId: '' as Uuid })), 'POLICY_CUSTOMER_REQUIRED'],
    ['blank receivableId', () => assertActionRequest(baseRequest({ receivableId: ' ' as Uuid })), 'POLICY_SUBJECT_INVALID'],
    ['blank caseId', () => assertActionRequest(baseRequest({ caseId: '' as Uuid })), 'POLICY_SUBJECT_INVALID'],
    ['missing actor', () => assertActionRequest(baseRequest({ actor: null as unknown as ActionRequest['actor'] })), 'POLICY_ACTOR_REQUIRED'],
    ['blank actorId', () => assertActionRequest(baseRequest({ actor: { type: 'ai_agent', actorId: ' ' } })), 'POLICY_ACTOR_REQUIRED'],
    ['unknown actor type', () => assertActionRequest(baseRequest({ actor: { type: 'ghost' as ActionRequest['actor']['type'], actorId: 'x' } })), 'POLICY_ACTOR_TYPE_INVALID'],
    ['human actor claiming autonomous', () => assertActionRequest(baseRequest({ actor: { type: 'human', actorId: 'u-1' }, autonomous: true })), 'POLICY_AUTONOMY_MISMATCH'],
    ['non-string actionType', () => assertActionRequest(baseRequest({ actionType: 42 as unknown as string })), 'POLICY_ACTION_TYPE_INVALID'],
    ['amount without currency', () => assertActionRequest(baseRequest({ amountMinor: 100, currency: null })), 'POLICY_AMOUNT_INVALID'],
    ['currency without amount', () => assertActionRequest(baseRequest({ amountMinor: null, currency: 'KES' })), 'POLICY_AMOUNT_INVALID'],
    ['negative amount', () => assertActionRequest(baseRequest({ amountMinor: -1, currency: 'KES' })), 'POLICY_AMOUNT_INVALID'],
    ['fractional amount', () => assertActionRequest(baseRequest({ amountMinor: 10.5, currency: 'KES' })), 'POLICY_AMOUNT_INVALID'],
    ['unsafe-integer amount', () => assertActionRequest(baseRequest({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'KES' })), 'POLICY_AMOUNT_INVALID'],
    ['unknown currency', () => assertActionRequest(baseRequest({ amountMinor: 100, currency: 'BTC' as never })), 'POLICY_CURRENCY_INVALID'],
    ['unknown risk class', () => assertActionRequest(baseRequest({ riskClass: 'existential' as never })), 'POLICY_RISK_CLASS_INVALID'],
    ['unknown channel', () => assertActionRequest(baseRequest({ channel: 'carrier_pigeon' as never })), 'POLICY_CHANNEL_INVALID'],
    ['non-boolean consentPresent', () => assertActionRequest(baseRequest({ consentPresent: 'yes' as unknown as boolean })), 'POLICY_REQUEST_FLAG_INVALID'],
    ['non-boolean disputeOpen', () => assertActionRequest(baseRequest({ disputeOpen: 1 as unknown as boolean })), 'POLICY_REQUEST_FLAG_INVALID'],
    ['non-boolean promisePending', () => assertActionRequest(baseRequest({ promisePending: null as unknown as boolean })), 'POLICY_REQUEST_FLAG_INVALID'],
    ['non-boolean autonomous', () => assertActionRequest(baseRequest({ autonomous: undefined as unknown as boolean })), 'POLICY_REQUEST_FLAG_INVALID'],
  ])('%s', (_label, run, code) => {
    expectCode(run, code);
  });

  it('accepts every actor type with autonomous=true except human', () => {
    for (const type of ACTOR_TYPES) {
      const run = () =>
        assertActionRequest(baseRequest({ actor: { type, actorId: 'a-1' }, autonomous: true }));
      if (type === 'human') expectCode(run, 'POLICY_AUTONOMY_MISMATCH');
      else expect(run).not.toThrow();
    }
  });

  it('accepts zero amounts (a zero write-off is quantified)', () => {
    expect(() => assertActionRequest(baseRequest({ actionType: 'write_off', amountMinor: 0, currency: 'KES' }))).not.toThrow();
  });
});

// --- tier 2: unknown action types are governed, not rejected -------------------------

describe('unknown action types pass validation (governed later)', () => {
  it.each(['wipe_ledger', 'napalm_strike', 'send_fax', ''])('%s does not throw', (actionType) => {
    expect(() => assertActionRequest(baseRequest({ actionType }))).not.toThrow();
  });
});

// --- effectiveChannel -----------------------------------------------------------------

describe('effectiveChannel', () => {
  it.each([
    ['explicit channel wins over the implied one', 'send_whatsapp', 'sms' as const, 'sms'],
    ['send_whatsapp implies whatsapp', 'send_whatsapp', null, 'whatsapp'],
    ['send_sms implies sms', 'send_sms', null, 'sms'],
    ['send_reminder with no channel stays null', 'send_reminder', null, null],
    ['send_reminder keeps its explicit channel', 'send_reminder', 'email' as const, 'email'],
    ['unknown action types imply nothing', 'send_fax', null, null],
    ['escalate with no channel stays null', 'escalate', null, null],
  ])('%s', (_label, actionType, channel, expected) => {
    expect(effectiveChannel(baseRequest({ actionType, channel }))).toBe(expected);
  });
});

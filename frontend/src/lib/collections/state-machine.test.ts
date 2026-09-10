import { describe, expect, it } from 'vitest';
import { specCase } from '@/lib/api/fixtures/collections';
import type { CaseActionView, CaseView } from '@/lib/api/wire-types';
import {
  ACTION_TYPE_LABELS,
  CASE_TRANSITIONS,
  caseActionLadder,
  defaultSourceFor,
  derivedStatusBadgeTone,
  escalationTargets,
  isCaseLive,
  isOutboundActionType,
  legalTransitions,
  priorityBadgeTone,
  requiresDunningConsent,
  statusBadgeTone,
  TRANSITION_LABELS,
} from './state-machine';

// =============================================================================
// STATE MACHINE + ACTION LADDER (issue #135): the UI mirrors the contract's
// transition table, the strictly-upward escalation ladder and the K2 dunning
// consent gate so it can only ever offer moves the wire accepts. Table
// provenance: spec lines 1272–1278 (edges), 1329–1334 (ladder),
// 1400–1405 + 2544–2548 (consent + source defaults).
// =============================================================================

describe('legal transition edges', () => {
  it('exposes exactly the contract edges: open → in_progress, in_progress → resolved|closed_inactive', () => {
    expect(legalTransitions('open')).toEqual(['in_progress']);
    expect(legalTransitions('in_progress')).toEqual(['resolved', 'closed_inactive']);
    expect(legalTransitions('resolved')).toEqual([]);
    expect(legalTransitions('closed_inactive')).toEqual([]);
  });

  it('holds the table as a total map over stored statuses (no gaps)', () => {
    expect(Object.keys(CASE_TRANSITIONS).sort()).toEqual(
      ['closed_inactive', 'in_progress', 'open', 'resolved'].sort(),
    );
  });

  it('never offers a move out of a terminal state (isCaseLive)', () => {
    expect(isCaseLive('open')).toBe(true);
    expect(isCaseLive('in_progress')).toBe(true);
    expect(isCaseLive('resolved')).toBe(false);
    expect(isCaseLive('closed_inactive')).toBe(false);
  });

  it('labels every stored status for transition affordances', () => {
    for (const status of Object.keys(CASE_TRANSITIONS) as (keyof typeof CASE_TRANSITIONS)[]) {
      expect(TRANSITION_LABELS[status].length).toBeGreaterThan(0);
    }
  });
});

describe('escalation ladder', () => {
  it('offers strictly-higher priorities only (low < normal < high < urgent)', () => {
    expect(escalationTargets('low')).toEqual(['normal', 'high', 'urgent']);
    expect(escalationTargets('normal')).toEqual(['high', 'urgent']);
    expect(escalationTargets('high')).toEqual(['urgent']);
    expect(escalationTargets('urgent')).toEqual([]);
  });
});

describe('K2 dunning consent', () => {
  it('treats sms/whatsapp as the outbound send types', () => {
    expect(isOutboundActionType('sms')).toBe(true);
    expect(isOutboundActionType('whatsapp')).toBe(true);
    expect(isOutboundActionType('call')).toBe(false);
    expect(isOutboundActionType('letter')).toBe(false);
    expect(isOutboundActionType('fieldVisit')).toBe(false);
    expect(isOutboundActionType('escalation')).toBe(false);
  });

  it('defaults the source per type: automated for outbound, manual otherwise', () => {
    expect(defaultSourceFor('sms')).toBe('automated');
    expect(defaultSourceFor('whatsapp')).toBe('automated');
    expect(defaultSourceFor('call')).toBe('manual');
    expect(defaultSourceFor('letter')).toBe('manual');
    expect(defaultSourceFor('fieldVisit')).toBe('manual');
    expect(defaultSourceFor('escalation')).toBe('manual');
  });

  it('requires consent only for automated outbound sends (the K2 gate)', () => {
    expect(requiresDunningConsent('sms', 'automated')).toBe(true);
    expect(requiresDunningConsent('whatsapp', 'automated')).toBe(true);
    // Manual outbound is a human send — not gated (mirrors the lane).
    expect(requiresDunningConsent('sms', 'manual')).toBe(false);
    expect(requiresDunningConsent('call', 'automated')).toBe(false);
    expect(requiresDunningConsent('letter', 'manual')).toBe(false);
  });
});

describe('case action ladder', () => {
  function actionWith(partial: Partial<CaseActionView> & { id: string }): CaseActionView {
    return {
      type: 'call',
      scheduledFor: '2026-09-02T09:00:00.000Z',
      outcome: null,
      completedAt: null,
      completedBy: null,
      consentRef: null,
      source: 'manual',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-09-01T09:00:00.000Z',
      ...partial,
    };
  }

  it('derives the full ladder for a live case: edges, higher targets, recordable types, open actions', () => {
    const c: CaseView = {
      ...specCase,
      status: 'in_progress',
      priority: 'normal',
      actions: [
        actionWith({ id: 'open-1' }),
        actionWith({ id: 'done-1', completedAt: '2026-09-02T09:20:00.000Z' }),
      ],
    };
    expect(caseActionLadder(c)).toEqual({
      transitions: [
        { to: 'resolved', label: TRANSITION_LABELS.resolved },
        { to: 'closed_inactive', label: TRANSITION_LABELS.closed_inactive },
      ],
      escalations: ['high', 'urgent'],
      recordableTypes: ['call', 'sms', 'whatsapp', 'letter', 'fieldVisit', 'escalation'],
      completableActionIds: ['open-1'],
    });
  });

  it('offers an empty ladder for terminal cases — the log is sealed (409 CASE_CLOSED)', () => {
    for (const status of ['resolved', 'closed_inactive'] as const) {
      const c: CaseView = { ...specCase, status };
      expect(caseActionLadder(c)).toEqual({
        transitions: [],
        escalations: [],
        recordableTypes: [],
        completableActionIds: [],
      });
    }
  });

  it('seals completions too: no completable ids when every action is stamped', () => {
    const c: CaseView = {
      ...specCase,
      status: 'open',
      actions: [actionWith({ id: 'done', completedAt: '2026-09-02T09:20:00.000Z' })],
    };
    expect(caseActionLadder(c).completableActionIds).toEqual([]);
  });

  it('labels every recordable action type', () => {
    const c: CaseView = { ...specCase };
    for (const type of caseActionLadder(c).recordableTypes) {
      expect(ACTION_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });
});

describe('badge tones (state machine badges)', () => {
  it('maps stored statuses consistently', () => {
    expect(statusBadgeTone('open')).toBe('info');
    expect(statusBadgeTone('in_progress')).toBe('info');
    expect(statusBadgeTone('resolved')).toBe('success');
    expect(statusBadgeTone('closed_inactive')).toBe('neutral');
  });

  it('maps the derived overlays: promised warns, disputed is danger, waiting is neutral', () => {
    expect(derivedStatusBadgeTone('promised')).toBe('warning');
    expect(derivedStatusBadgeTone('disputed')).toBe('danger');
    expect(derivedStatusBadgeTone('waiting')).toBe('neutral');
    // Stored statuses fall through to the stored-status semantics.
    expect(derivedStatusBadgeTone('resolved')).toBe('success');
  });

  it('heats up the priority ladder', () => {
    expect(priorityBadgeTone('low')).toBe('neutral');
    expect(priorityBadgeTone('normal')).toBe('info');
    expect(priorityBadgeTone('high')).toBe('warning');
    expect(priorityBadgeTone('urgent')).toBe('danger');
  });
});

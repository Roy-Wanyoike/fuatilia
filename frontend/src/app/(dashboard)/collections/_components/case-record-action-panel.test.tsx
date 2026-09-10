import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseRecordActionPanel } from './case-record-action-panel';
import { createCollectionsClient, type CollectionsCaseClient } from '@/lib/collections/case-ops';
import type { FetchLike } from '@/lib/api/client';
import {
  caseActionRecordedExample,
  specCase,
} from '@/lib/api/fixtures/collections';

// =============================================================================
// RECORD-ACTION FLOW (issue #135): per-type source defaults, Nairobi-offset
// schedule, the K2 consent gate enforced locally AND surfaced verbatim when
// the wire refuses, honest appending (the log only grows on a 201).
// =============================================================================

afterEach(() => {
  cleanup();
});

const RID = '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': RID },
  });
}

/** The 201 envelope — the post-append case AND the action (spec 1427–1466). */
const recordedEnvelope = {
  data: {
    case: caseActionRecordedExample.data.case,
    action: caseActionRecordedExample.data.case.actions[0] ?? null,
  },
};

function renderPanel(recorded: { status: number; body: unknown } | null = null): {
  onCaseReplaced: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (recorded === null) throw new Error(`no route stub for ${url}`);
    if (url.includes('/actions')) return jsonResponse(recorded.status, recorded.body);
    throw new Error(`no route stub for ${url}`);
  };
  const writeClient: CollectionsCaseClient = createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
  const onCaseReplaced = vi.fn();
  render(
    <CaseRecordActionPanel caseView={specCase} writeClient={writeClient} onCaseReplaced={onCaseReplaced} />,
  );
  return { onCaseReplaced, calls };
}

async function fillSchedule(value = '2026-09-02T09:00'): Promise<void> {
  // jsdom needs the full valid value in one change event (typing into a
  // datetime-local fills nothing but garbage intermediates).
  fireEvent.change(screen.getByLabelText(/Scheduled for/), {
    target: { value },
  });
}

describe('CaseRecordActionPanel defaults', () => {
  it('defaults the source per type: manual call, automated sms (spec body default)', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('manual');
    await user.selectOptions(screen.getByLabelText('Type'), 'sms');
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('automated');
    await user.selectOptions(screen.getByLabelText('Type'), 'call');
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('manual');
  });

  it('requires the K2 consent reference only for automated outbound sends', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.queryByLabelText(/Dunning consent reference/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type'), 'sms');
    // automated is the sms default → the K2 gate input appears, required
    expect(screen.getByLabelText(/Dunning consent reference/)).toBeRequired();
    await user.selectOptions(screen.getByLabelText('Source'), 'manual');
    // manual sms is not an automated outbound send → no gate
    expect(screen.queryByLabelText(/Dunning consent reference/)).not.toBeInTheDocument();
  });

  it('is honest for a terminal case — the log is sealed', () => {
    renderPanel();
    cleanup();
    render(
      <CaseRecordActionPanel
        caseView={{ ...specCase, status: 'closed_inactive' }}
        writeClient={createCollectionsClient({ baseUrl: 'http://collections.test' })}
        onCaseReplaced={vi.fn()}
      />,
    );
    expect(screen.getByTestId('case-record-action-sealed')).toHaveTextContent(
      'action log is sealed',
    );
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
  });
});

describe('CaseRecordActionPanel submission', () => {
  it('refuses a missing schedule or consent locally — before the wire', async () => {
    const user = userEvent.setup();
    const { calls } = renderPanel({ status: 201, body: recordedEnvelope });
    await user.click(screen.getByRole('button', { name: 'Record action' }));
    expect(screen.getByTestId('case-record-action-local-error')).toHaveTextContent(
      'Enter a valid schedule',
    );
    expect(calls).toHaveLength(0);

    await user.selectOptions(screen.getByLabelText('Type'), 'sms'); // automated → consent gate
    await fillSchedule();
    await user.click(screen.getByRole('button', { name: 'Record action' }));
    expect(screen.getByTestId('case-record-action-local-error')).toHaveTextContent(
      'requires a dunning consent reference',
    );
    expect(calls).toHaveLength(0);
  });

  it('posts RecordActionBody with the +03:00 Nairobi offset and hands the recorded pair back', async () => {
    const user = userEvent.setup();
    const { onCaseReplaced, calls } = renderPanel({ status: 201, body: recordedEnvelope });
    await fillSchedule();
    await user.click(screen.getByRole('button', { name: 'Record action' }));

    expect(await screen.findByTestId('case-record-action-success')).toHaveTextContent(
      'Call recorded — scheduled for 2026-09-02 12:00.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${specCase.id}/actions`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      type: 'call',
      scheduledFor: '2026-09-02T09:00:00+03:00',
      source: 'manual',
    });
    expect(onCaseReplaced).toHaveBeenCalledWith(caseActionRecordedExample.data.case, RID);
  });

  it('carries the consentRef on an automated outbound send', async () => {
    const user = userEvent.setup();
    const { calls } = renderPanel({ status: 201, body: recordedEnvelope });
    await user.selectOptions(screen.getByLabelText('Type'), 'whatsapp');
    await fillSchedule();
    await user.type(
      screen.getByLabelText(/Dunning consent reference/),
      'consent-8f3e-2026',
    );
    await user.click(screen.getByRole('button', { name: 'Record action' }));

    expect(await screen.findByTestId('case-record-action-success')).toBeInTheDocument();
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      type: 'whatsapp',
      scheduledFor: '2026-09-02T09:00:00+03:00',
      source: 'automated',
      consentRef: 'consent-8f3e-2026',
    });
  });

  it('surfaces 403 DUNNING_CONSENT_REQUIRED verbatim — nothing was sent', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: 403,
      body: {
        error: {
          code: 'DUNNING_CONSENT_REQUIRED',
          message:
            'automated sms dunning on case CASE-000007 requires an active dunning consent reference (K2) — nothing was sent',
        },
        requestId: RID,
      },
    });
    await user.selectOptions(screen.getByLabelText('Type'), 'sms');
    await fillSchedule();
    await user.type(screen.getByLabelText(/Dunning consent reference/), 'stale-ref');
    await user.click(screen.getByRole('button', { name: 'Record action' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: DUNNING_CONSENT_REQUIRED');
    expect(alert).toHaveTextContent(RID);
    expect(alert).toHaveTextContent('nothing was sent');
  });

  it('surfaces 409 CASE_CLOSED when the log was sealed in a race', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: 409,
      body: {
        error: { code: 'CASE_CLOSED', message: 'case CASE-000007 is resolved — its action log is sealed' },
        requestId: RID,
      },
    });
    await fillSchedule();
    await user.click(screen.getByRole('button', { name: 'Record action' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_CLOSED');
    expect(alert).toHaveTextContent(RID);
  });
});

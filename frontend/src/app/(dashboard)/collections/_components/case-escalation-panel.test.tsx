import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseEscalationPanel } from './case-escalation-panel';
import { createCollectionsClient, type CollectionsCaseClient } from '@/lib/collections/case-ops';
import type { FetchLike } from '@/lib/api/client';
import { specCase } from '@/lib/api/fixtures/collections';

// =============================================================================
// ESCALATION FLOW (issue #135): strictly-upward targets only, honest
// top-of-the-ladder state, reasons enforced locally, refusals verbatim.
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

function renderPanel(
  route: { status: number; body: unknown } | null,
  caseView = specCase, // priority high → only `urgent` is above it
): { onCaseReplaced: ReturnType<typeof vi.fn>; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (route === null) throw new Error(`no route stub for ${url}`);
    if (url.includes('/escalations')) return jsonResponse(route.status, route.body);
    throw new Error(`no route stub for ${url}`);
  };
  const writeClient: CollectionsCaseClient = createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
  const onCaseReplaced = vi.fn();
  render(
    <CaseEscalationPanel caseView={caseView} writeClient={writeClient} onCaseReplaced={onCaseReplaced} />,
  );
  return { onCaseReplaced, calls };
}

describe('CaseEscalationPanel ladder', () => {
  it('offers only strictly-higher priorities (high → urgent)', () => {
    renderPanel(null);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]).toBeChecked();
    expect(screen.getByRole('button', { name: 'Escalate to urgent' })).toBeInTheDocument();
  });

  it('offers the full remaining climb from low', () => {
    renderPanel(null, { ...specCase, priority: 'low' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3); // normal, high, urgent — never low itself
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'normal',
      'high',
      'urgent',
    ]);
  });

  it('is honest at the top of the ladder — no form, no wire call', () => {
    const { calls } = renderPanel(null, { ...specCase, priority: 'urgent' });
    expect(screen.getByTestId('case-escalation-exhausted')).toHaveTextContent(
      'already at the top of the ladder',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Escalate to/ })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('CaseEscalationPanel submission', () => {
  it('refuses a blank reason locally — before the wire', async () => {
    const user = userEvent.setup();
    const { calls } = renderPanel({ status: 200, body: { data: { case: specCase } } });
    await user.click(screen.getByRole('button', { name: 'Escalate to urgent' }));
    expect(screen.getByTestId('case-escalation-local-error')).toHaveTextContent(
      'A reason is required',
    );
    expect(calls).toHaveLength(0);
  });

  it('posts EscalationBody {to, reason} and hands the server case view back', async () => {
    const user = userEvent.setup();
    const escalated = { ...specCase, priority: 'urgent' as const };
    const { onCaseReplaced, calls } = renderPanel({
      status: 200,
      body: { data: { case: escalated } },
    });
    await user.type(
      screen.getByLabelText(/Escalation reason/),
      '60+ days overdue and site access at risk',
    );
    await user.click(screen.getByRole('button', { name: 'Escalate to urgent' }));

    expect(await screen.findByTestId('case-escalation-success')).toHaveTextContent(
      'Case escalated to urgent.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${specCase.id}/escalations`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      to: 'urgent',
      reason: '60+ days overdue and site access at risk',
    });
    expect(onCaseReplaced).toHaveBeenCalledTimes(1);
    expect(onCaseReplaced).toHaveBeenCalledWith(escalated, RID);
  });

  it('surfaces CASE_ESCALATION_INVALID verbatim with code + requestId', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: 400,
      body: {
        error: {
          code: 'CASE_ESCALATION_INVALID',
          message: 'escalation must strictly raise the priority; high → high does not',
        },
        requestId: RID,
      },
    });
    await user.type(screen.getByLabelText(/Escalation reason/), 'sidestep attempt');
    await user.click(screen.getByRole('button', { name: 'Escalate to urgent' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_ESCALATION_INVALID');
    expect(alert).toHaveTextContent(RID);
    expect(alert).toHaveTextContent('must strictly raise the priority');
  });
});

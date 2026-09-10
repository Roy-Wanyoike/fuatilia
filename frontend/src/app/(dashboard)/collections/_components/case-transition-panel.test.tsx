import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseTransitionPanel } from './case-transition-panel';
import { createCollectionsClient, type CollectionsCaseClient } from '@/lib/collections/case-ops';
import type { FetchLike } from '@/lib/api/client';
import {
  caseDetailExample,
  specCase,
} from '@/lib/api/fixtures/collections';

// =============================================================================
// TRANSITION FLOW (issue #135): only legal edges are offered, reasons are
// enforced before the wire, refusals surface code + requestId, and the
// panel is done only when the server's post-transition view lands.
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

interface Route {
  status: number;
  body: unknown;
}

function renderPanel(
  routes: Record<string, Route>,
  caseView = specCase,
): { onCaseReplaced: ReturnType<typeof vi.fn>; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
  const writeClient: CollectionsCaseClient = createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
  const onCaseReplaced = vi.fn();
  render(
    <CaseTransitionPanel caseView={caseView} writeClient={writeClient} onCaseReplaced={onCaseReplaced} />,
  );
  return { onCaseReplaced, calls };
}

/** The in_progress post-transition view (spec lines 1216–1249). */
const inProgressCase = caseDetailExample.data.case;
const transitionedEnvelope = { data: { case: inProgressCase } };

describe('CaseTransitionPanel ladder', () => {
  it('offers exactly the legal edges of the current state', () => {
    renderPanel({}, specCase); // open → in_progress only
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]).toBeChecked();
    expect(screen.getByRole('button', { name: 'Move to In progress' })).toBeInTheDocument();
  });

  it('offers both in_progress edges and starts on the first', () => {
    renderPanel({}, inProgressCase); // in_progress → resolved | closed_inactive
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it('says so honestly for a terminal case — no form, no wire call', () => {
    const { calls } = renderPanel(
      {},
      { ...specCase, status: 'resolved' },
    );
    expect(screen.getByTestId('case-transition-sealed')).toHaveTextContent(
      'terminal state takes no edges',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('CaseTransitionPanel submission', () => {
  it('refuses a blank reason locally — before the wire', async () => {
    const user = userEvent.setup();
    const { calls } = renderPanel({
      '/transitions': { status: 200, body: transitionedEnvelope },
    });
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));
    expect(screen.getByTestId('case-transition-local-error')).toHaveTextContent(
      'A reason is required',
    );
    expect(calls).toHaveLength(0);
  });

  it('posts TransitionBody {to, reason} and hands the server case view back', async () => {
    const user = userEvent.setup();
    const { onCaseReplaced, calls } = renderPanel({
      '/transitions': { status: 200, body: transitionedEnvelope },
    });
    await user.type(
      screen.getByLabelText(/Transition reason/),
      'collector engaged',
    );
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));

    expect(await screen.findByTestId('case-transition-success')).toHaveTextContent(
      'Case moved to In progress.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${specCase.id}/transitions`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      to: 'in_progress',
      reason: 'collector engaged',
    });
    expect(onCaseReplaced).toHaveBeenCalledTimes(1);
    expect(onCaseReplaced).toHaveBeenCalledWith(inProgressCase, RID);
  });

  it('surfaces CASE_TRANSITION_INVALID verbatim with code + requestId', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/transitions': {
        status: 400,
        body: {
          error: {
            code: 'CASE_TRANSITION_INVALID',
            message: 'cannot move a case from resolved to in_progress',
          },
          requestId: RID,
        },
      },
    });
    await user.type(screen.getByLabelText(/Transition reason/), 'retry the same edge');
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_TRANSITION_INVALID');
    expect(alert).toHaveTextContent(RID);
    expect(alert).toHaveTextContent('cannot move a case from resolved to in_progress');
  });

  it('surfaces CASE_CLOSED (sealed log) when the race hits a closed case', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/transitions': {
        status: 409,
        body: {
          error: { code: 'CASE_CLOSED', message: 'case CASE-000007 is resolved' },
          requestId: RID,
        },
      },
    });
    await user.type(screen.getByLabelText(/Transition reason/), 'racing a close elsewhere');
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_CLOSED');
    expect(alert).toHaveTextContent(RID);
  });

  it('shows the honest submitting state while the POST is in flight', async () => {
    const user = userEvent.setup();
    const slowCalls: Array<{ url: string; body: string }> = [];
    const slowFetch: FetchLike = async (input, init) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      slowCalls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return jsonResponse(200, transitionedEnvelope);
    };
    const writeClient: CollectionsCaseClient = createCollectionsClient({
      baseUrl: 'http://collections.test',
      fetchImpl: slowFetch,
    });
    const onCaseReplaced = vi.fn();
    render(
      <CaseTransitionPanel
        caseView={specCase}
        writeClient={writeClient}
        onCaseReplaced={onCaseReplaced}
      />,
    );
    await user.type(screen.getByLabelText(/Transition reason/), 'collector engaged');
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));
    expect(await screen.findByRole('button', { name: 'Moving…' })).toBeDisabled();
    await screen.findByTestId('case-transition-success');
    expect(slowCalls).toHaveLength(1);
  });
});

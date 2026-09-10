import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseCompleteActionPanel } from './case-complete-action-panel';
import { createCollectionsClient, type CollectionsCaseClient } from '@/lib/collections/case-ops';
import type { FetchLike } from '@/lib/api/client';
import type { CaseView } from '@/lib/api/wire-types';
import {
  caseActionRecordedExample,
  caseDetailExample,
  specCase,
} from '@/lib/api/fixtures/collections';

// =============================================================================
// COMPLETE-ACTION FLOW (issue #135): only uncompleted actions are offered,
// the outcome is mandatory locally, the completion stamps exactly once and
// re-completion refusals surface verbatim with code + requestId.
// =============================================================================

afterEach(() => {
  cleanup();
});

const RID = '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70';
const OPEN_ACTION_ID = 'a1b2c3d4e5f60718293a4b5c';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': RID },
  });
}

/** Case with one uncompleted action (spec 1427–1466 shapes). */
const caseWithOpenAction = caseActionRecordedExample.data.case;

/** Case where that action is already completed (spec 1216–1249 shape). */
const caseWithCompletedAction = caseDetailExample.data.case;

function renderPanel(
  route: { status: number; body: unknown } | null,
  caseView: CaseView = caseWithOpenAction,
): { onCaseReplaced: ReturnType<typeof vi.fn>; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '' });
    if (route === null) throw new Error(`no route stub for ${url}`);
    if (url.includes('/completions')) return jsonResponse(route.status, route.body);
    throw new Error(`no route stub for ${url}`);
  };
  const writeClient: CollectionsCaseClient = createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
  const onCaseReplaced = vi.fn();
  render(
    <CaseCompleteActionPanel caseView={caseView} writeClient={writeClient} onCaseReplaced={onCaseReplaced} />,
  );
  return { onCaseReplaced, calls };
}

describe('CaseCompleteActionPanel ladder', () => {
  it('offers exactly the uncompleted actions — never completed ones', () => {
    renderPanel(null, {
      ...caseWithOpenAction,
      actions: [...caseWithOpenAction.actions, ...caseWithCompletedAction.actions],
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Call — scheduled 2026-09-02 12:00');
  });

  it('is honest when nothing awaits completion (fresh case)', () => {
    const { calls } = renderPanel(null, specCase);
    expect(screen.getByTestId('case-complete-action-empty')).toHaveTextContent(
      'No actions recorded on this case yet',
    );
    expect(screen.queryByLabelText(/Outcome/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete action' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('is honest when every recorded action is already completed', () => {
    renderPanel(null, caseWithCompletedAction);
    expect(screen.getByTestId('case-complete-action-empty')).toHaveTextContent(
      'already completed',
    );
  });
});

describe('CaseCompleteActionPanel submission', () => {
  it('refuses a blank outcome locally — before the wire', async () => {
    const user = userEvent.setup();
    const { calls } = renderPanel({ status: 200, body: { data: { case: caseWithCompletedAction } } });
    await user.click(screen.getByRole('button', { name: 'Complete action' }));
    expect(screen.getByTestId('case-complete-action-local-error')).toHaveTextContent(
      'An outcome is required',
    );
    expect(calls).toHaveLength(0);
  });

  it('posts CompleteActionBody to the completions URL and hands the server case back', async () => {
    const user = userEvent.setup();
    const { onCaseReplaced, calls } = renderPanel({
      status: 200,
      body: { data: { case: caseWithCompletedAction } },
    });
    await user.type(
      screen.getByLabelText(/^Outcome/),
      'spoke to site foreman — promised part payment',
    );
    await user.click(screen.getByRole('button', { name: 'Complete action' }));

    expect(await screen.findByTestId('case-complete-action-success')).toHaveTextContent(
      'Action completed with outcome “spoke to site foreman — promised part payment”.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://collections.test/v1/collections/cases/${specCase.id}/actions/${OPEN_ACTION_ID}/completions`,
    );
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      outcome: 'spoke to site foreman — promised part payment',
    });
    expect(onCaseReplaced).toHaveBeenCalledWith(caseWithCompletedAction, RID);
  });

  it('surfaces 409 CASE_ACTION_ALREADY_COMPLETED verbatim (the stamp is once-only)', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: 409,
      body: {
        error: {
          code: 'CASE_ACTION_ALREADY_COMPLETED',
          message: `action ${OPEN_ACTION_ID} was already completed at 2026-09-02T09:20:00.000Z`,
        },
        requestId: RID,
      },
    });
    await user.type(screen.getByLabelText(/^Outcome/), 'second stamp attempt');
    await user.click(screen.getByRole('button', { name: 'Complete action' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_ACTION_ALREADY_COMPLETED');
    expect(alert).toHaveTextContent(RID);
  });

  it('surfaces 404 CASE_ACTION_NOT_FOUND verbatim', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: 404,
      body: {
        error: {
          code: 'CASE_ACTION_NOT_FOUND',
          message: `case CASE-000007 has no action ${OPEN_ACTION_ID}`,
        },
        requestId: RID,
      },
    });
    await user.type(screen.getByLabelText(/^Outcome/), 'stale list race');
    await user.click(screen.getByRole('button', { name: 'Complete action' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: CASE_ACTION_NOT_FOUND');
    expect(alert).toHaveTextContent(RID);
  });
});

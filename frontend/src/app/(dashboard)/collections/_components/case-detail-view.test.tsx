import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { CaseDetailView } from './case-detail-view';
import { createFuatiliaClient, type FetchLike } from '@/lib/api/client';
import { createCollectionsClient } from '@/lib/collections/case-ops';
import {
  caseDetailExample,
  caseNotFoundExample,
  specCase,
} from '@/lib/api/fixtures/collections';
import { receivableDetailExample } from '@/lib/api/fixtures/receivables';

// =============================================================================
// CASE DETAIL WORKSPACE (issue #135): GET /v1/collections/cases/{caseId}
// honest loading/refusal states, money from the real receivables read
// model, and a write flow that replaces the view ONLY with the server's
// own post-transition answer.
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

/**
 * Route stubs, most specific first: /transitions, /escalations,
 * /completions, /actions, then the two GET surfaces (case detail,
 * receivables). Case-detail GETs can be scripted per call.
 */
function renderDetail(routes: Record<string, Route>, caseGetScript?: Route[]): void {
  let caseGetCall = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes('/v1/collections/cases/') && init.method !== 'POST') {
      const route = caseGetScript
        ? (caseGetScript[Math.min(caseGetCall, caseGetScript.length - 1)] ?? routes['#caseGet'])
        : routes['#caseGet'];
      caseGetCall += 1;
      return jsonResponse(route?.status ?? 500, route?.body);
    }
    for (const [fragment, route] of Object.entries(routes)) {
      if (fragment.startsWith('#')) continue;
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
  const read = createFuatiliaClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  const write = createCollectionsClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    requestIdGenerator: () => 'test-req-1',
  });
  render(
    <QueryProviders>
      <CaseDetailView caseId={specCase.id} readClient={read} writeClient={write} />
    </QueryProviders>,
  );
}

const inProgressCase = caseDetailExample.data.case;

describe('CaseDetailView read states', () => {
  it('shows skeletons while the case is in flight (no invented rows)', async () => {
    renderDetail({
      '#caseGet': { status: 200, body: { data: { case: specCase } } },
    });
    expect(screen.getByTestId('case-detail-loading')).toHaveAttribute('aria-busy', 'true');

    await screen.findByTestId('case-detail');
    expect(screen.queryByTestId('case-detail-loading')).not.toBeInTheDocument();
  });

  it('surfaces the 404 envelope verbatim — unknown/foreign case stays a refusal', async () => {
    renderDetail({
      '#caseGet': { status: 404, body: caseNotFoundExample },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: HTTP_CASE_NOT_FOUND');
    expect(alert).toHaveTextContent(RID);
    expect(alert).toHaveTextContent('does not exist');
    expect(screen.getByTestId('case-detail-heading')).toHaveTextContent('Case');
    expect(screen.queryByTestId('case-detail')).not.toBeInTheDocument();
  });

  it('retries honestly: a 500 refusal offers Retry and a retry can succeed', async () => {
    const user = userEvent.setup();
    renderDetail(
      {
        '/v1/receivables/': { status: 200, body: receivableDetailExample },
      },
      [
        { status: 500, body: { error: { code: 'HTTP_INTERNAL', message: 'boom' }, requestId: RID } },
        { status: 200, body: { data: { case: specCase } } },
      ],
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('code: HTTP_INTERNAL');
    expect(alert).toHaveTextContent(RID);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('case-detail');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the workspace: summary badges, money from the read model, all four flows, the log', async () => {
    renderDetail({
      '#caseGet': { status: 200, body: { data: { case: specCase } } },
      '/v1/receivables/': { status: 200, body: receivableDetailExample },
    });

    await screen.findByTestId('case-detail');
    expect(screen.getByTestId('case-detail-heading')).toHaveTextContent('Case CASE-000007');
    expect(screen.getByTestId('case-status-badge')).toHaveTextContent('Open');
    // Money comes from the receivables read model, fetched after the case lands
    expect(await screen.findByTestId('case-balance-total')).toHaveTextContent(
      'Outstanding: KES 75,000.00',
    );
    // All four write flows are present and driven by the ladder
    expect(screen.getByTestId('case-transition-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to In progress' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Escalate to urgent' })).toBeInTheDocument();
    expect(screen.getByTestId('case-record-action-panel')).toBeInTheDocument();
    expect(screen.getByTestId('case-complete-action-empty')).toHaveTextContent(
      'No actions recorded on this case yet',
    );
    expect(screen.getByTestId('case-action-log')).toBeInTheDocument();
  });
});

describe('CaseDetailView write integration (transition)', () => {
  it('replaces the case view with the server post-transition answer — badge flips without optimistic invention', async () => {
    const user = userEvent.setup();
    renderDetail(
      {
        '/transitions': { status: 200, body: { data: { case: inProgressCase } } },
        '/v1/receivables/': { status: 200, body: receivableDetailExample },
      },
      [
        { status: 200, body: { data: { case: specCase } } },
        { status: 200, body: { data: { case: inProgressCase } } },
      ],
    );

    await screen.findByTestId('case-detail');
    expect(screen.getByTestId('case-status-badge')).toHaveTextContent('Open');

    await user.type(screen.getByLabelText(/Transition reason/), 'collector engaged');
    await user.click(screen.getByRole('button', { name: 'Move to In progress' }));

    await waitFor(() => {
      expect(screen.getByTestId('case-status-badge')).toHaveTextContent('In progress');
    });
    // The server's confirmation AND the sealed log agree — no invented rows
    expect(await screen.findByTestId('case-transition-success')).toHaveTextContent(
      'Case moved to In progress.',
    );
    await waitFor(() => {
      expect(screen.getByTestId('case-log-history-row')).toHaveTextContent(
        'Open → In progress',
      );
    });
    // The ladder moved on: open → in_progress has been consumed
    expect(screen.getByRole('button', { name: 'Move to Resolved' })).toBeInTheDocument();
  });
});

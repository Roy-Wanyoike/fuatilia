import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { OpenCasePanel } from './open-case-panel';
import { createFuatiliaClient, type FetchLike } from '@/lib/api/client';
import { createCollectionsClient } from '@/lib/collections/case-ops';
import { specCase } from '@/lib/api/fixtures/collections';
import { specReceivable } from '@/lib/api/fixtures/receivables';
import { caseAlreadyOpenExample } from '@/lib/api/fixtures/collections';

// =============================================================================
// OPEN-CASE FLOW (issue #135): receivables picked from the real read model,
// the R8 conflict surfaced verbatim, honest submitting/success states.
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

function makeClients(routes: Record<string, Route>): {
  read: ReturnType<typeof createFuatiliaClient>;
  write: ReturnType<typeof createCollectionsClient>;
  calls: Array<{ url: string; method: string; body: string }>;
} {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : '',
    });
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
  return {
    read: createFuatiliaClient({
      baseUrl: 'http://collections.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'test-req-1',
    }),
    write: createCollectionsClient({
      baseUrl: 'http://collections.test',
      fetchImpl,
      requestIdGenerator: () => 'test-req-1',
    }),
    calls,
  };
}

function renderPanel(
  routes: Record<string, Route>,
): Array<{ url: string; method: string; body: string }> {
  const { read, write, calls } = makeClients(routes);
  render(
    <QueryProviders>
      <OpenCasePanel readClient={read} writeClient={write} />
    </QueryProviders>,
  );
  return calls;
}

async function expand(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open case…' }));
}

const receivablesEnvelope = {
  data: { receivables: [specReceivable] },
  meta: { pagination: { nextCursor: null, total: 1 } },
};

const openedEnvelope = { data: { case: specCase } };

describe('OpenCasePanel collapsed state', () => {
  it('renders the disclosure closed and fetches nothing until expanded', async () => {
    const calls = renderPanel({
      '/v1/receivables': { status: 200, body: receivablesEnvelope },
    });
    expect(screen.getByRole('button', { name: 'Open case…' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});

describe('OpenCasePanel picker states', () => {
  it('shows skeletons while receivables load, then checkbox rows with exact money', async () => {
    const user = userEvent.setup();
    const slow: FetchLike = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (String(input).includes('/v1/receivables')) {
        return jsonResponse(200, receivablesEnvelope);
      }
      throw new Error(`no route stub for ${input}`);
    };
    const write = createCollectionsClient({ baseUrl: 'http://collections.test' });
    const slowRead = createFuatiliaClient({
      baseUrl: 'http://collections.test',
      fetchImpl: slow,
      logger: null,
    });
    render(
      <QueryProviders>
        <OpenCasePanel readClient={slowRead} writeClient={write} />
      </QueryProviders>,
    );
    await user.click(screen.getByRole('button', { name: 'Open case…' }));
    expect(screen.getByTestId('open-case-receivables-loading')).toHaveAttribute('aria-busy', 'true');

    await screen.findByRole('checkbox');
    // The spec receivable carries KES 75,000.00 balance — exact minor units.
    const pickerRow = screen.getByRole('listitem');
    expect(pickerRow).toHaveTextContent('KES 75,000.00');
    expect(pickerRow).toHaveTextContent('partially_paid');
  });

  it('surfaces the receivables refusal with code + requestId and a retry', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/v1/receivables': { status: 401, body: { error: { code: 'HTTP_UNAUTHENTICATED', message: 'authentication required' }, requestId: RID } },
    });
    await user.click(screen.getByRole('button', { name: 'Open case…' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP_UNAUTHENTICATED');
    expect(alert).toHaveTextContent(RID);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('explains when no receivables exist yet', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/v1/receivables': {
        status: 200,
        body: { data: { receivables: [] }, meta: { pagination: { nextCursor: null, total: 0 } } },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Open case…' }));
    await screen.findByTestId('open-case-receivables-empty');
  });
});

describe('OpenCasePanel validation', () => {
  it('refuses to submit without a receivable or a collector — before the wire', async () => {
    const user = userEvent.setup();
    const calls = renderPanel({
      '/v1/receivables': { status: 200, body: receivablesEnvelope },
      '/v1/collections/cases': { status: 201, body: openedEnvelope },
    });
    await expand();
    await screen.findByRole('checkbox');
    await user.click(screen.getByRole('button', { name: 'Open case' }));
    expect(screen.getByTestId('open-case-local-error')).toHaveTextContent(
      'at least one receivable',
    );
    expect(calls.filter((call) => call.url.includes('/v1/collections/cases'))).toHaveLength(0);
  });
});

describe('OpenCasePanel submission', () => {
  it('posts the OpenCaseBody (picked + pasted ids, collector, priority) and shows the success link', async () => {
    const user = userEvent.setup();
    const calls = renderPanel({
      '/v1/receivables': { status: 200, body: receivablesEnvelope },
      '/v1/collections/cases': { status: 201, body: openedEnvelope },
    });
    await expand();
    await screen.findByRole('checkbox');
    await user.click(screen.getByRole('checkbox'));
    await user.type(
      screen.getByLabelText('Additional receivable ids (optional)'),
      ' cc0c0c0c-0000-4000-8000-000000000099 ',
    );
    await user.type(screen.getByLabelText('Collector id'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.click(screen.getByRole('button', { name: 'Open case' }));

    const status = await screen.findByTestId('open-case-success');
    expect(status).toHaveTextContent('Case CASE-000007 opened.');
    expect(within(status).getByRole('link', { name: 'Work the case →' })).toHaveAttribute(
      'href',
      `/collections/${specCase.id}`,
    );

    const post = calls.find((call) => call.url.includes('/v1/collections/cases'));
    expect(post).toBeDefined();
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      receivableIds: [
        specReceivable.id,
        'cc0c0c0c-0000-4000-8000-000000000099',
      ],
      collectorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      priority: 'high',
    });
  });

  it('shows the honest submitting state while the POST is in flight', async () => {
    const user = userEvent.setup();
    const read = createFuatiliaClient({
      baseUrl: 'http://collections.test',
      fetchImpl: async (input) => {
        if (String(input).includes('/v1/receivables')) return jsonResponse(200, receivablesEnvelope);
        throw new Error(`no route stub for ${input}`);
      },
      logger: null,
    });
    const slowWrite = createCollectionsClient({
      baseUrl: 'http://collections.test',
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return jsonResponse(201, openedEnvelope);
      },
    });
    render(
      <QueryProviders>
        <OpenCasePanel readClient={read} writeClient={slowWrite} />
      </QueryProviders>,
    );
    await user.click(screen.getByRole('button', { name: 'Open case…' }));
    await user.type(screen.getByLabelText('Collector id'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    await user.type(
      screen.getByLabelText('Additional receivable ids (optional)'),
      '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
    );
    await user.click(screen.getByRole('button', { name: 'Open case' }));
    expect(await screen.findByRole('button', { name: 'Opening…' })).toBeDisabled();
    await screen.findByTestId('open-case-success');
  });

  it('surfaces the R8 conflict verbatim: 409 CASE_ALREADY_OPEN with code + requestId', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/v1/receivables': { status: 200, body: receivablesEnvelope },
      '/v1/collections/cases': { status: 409, body: caseAlreadyOpenExample },
    });
    await expand();
    await user.type(screen.getByLabelText('Collector id'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    await user.type(
      screen.getByLabelText('Additional receivable ids (optional)'),
      '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
    );
    await user.click(screen.getByRole('button', { name: 'Open case' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("code: CASE_ALREADY_OPEN");
    expect(alert).toHaveTextContent(RID);
    expect(alert).toHaveTextContent('one open case per receivable');
  });

  it('surfaces the missing receivable 404 (HTTP_RECEIVABLE_NOT_FOUND) with the envelope message', async () => {
    const user = userEvent.setup();
    renderPanel({
      '/v1/receivables': { status: 200, body: receivablesEnvelope },
      '/v1/collections/cases': {
        status: 404,
        body: {
          error: {
            code: 'HTTP_RECEIVABLE_NOT_FOUND',
            message: 'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 does not exist',
          },
          requestId: RID,
        },
      },
    });
    await expand();
    await user.type(screen.getByLabelText('Collector id'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    await user.type(
      screen.getByLabelText('Additional receivable ids (optional)'),
      '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
    );
    await user.click(screen.getByRole('button', { name: 'Open case' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP_RECEIVABLE_NOT_FOUND');
    expect(alert).toHaveTextContent('does not exist');
  });
});

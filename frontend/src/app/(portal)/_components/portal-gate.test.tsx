import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalGate } from '@/app/(portal)/_components/portal-gate';

// =============================================================================
// PORTAL GATE (issue #86): the access code is pasted ONCE, POSTed in the
// request BODY (never a URL), validated against the live API server-side,
// and only then held in the httpOnly cookie. The refused path renders the
// contract envelope's code + requestId; nothing is fabricated.
// =============================================================================

const CODE = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(
  impl: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return impl(String(url), init);
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  refresh.mockClear();
});

async function pasteAndSubmit(code: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Portal access code'), code);
  await userEvent.click(screen.getByRole('button', { name: 'Open my account' }));
}

describe('PortalGate', () => {
  it('renders the access-code gate with a labelled input and an explainer', () => {
    render(<PortalGate />);
    expect(screen.getByRole('heading', { level: 1, name: 'Fuatilia payer portal' })).toBeInTheDocument();
    expect(screen.getByLabelText('Portal access code')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Open my account' })).toBeEnabled();
    // The tokenization contract is disclosed to the payer, in plain words.
    expect(screen.getByText(/HTTP-only, SameSite=Strict cookie/)).toBeInTheDocument();
    expect(screen.getByText(/never placed in a URL/)).toBeInTheDocument();
  });

  it('refuses to submit an empty code client-side without any network call', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<PortalGate />);
    await userEvent.click(screen.getByRole('button', { name: 'Open my account' }));
    expect(screen.getByTestId('gate-local-error')).toHaveTextContent(
      'Enter the access code you received.',
    );
    expect(calls).toHaveLength(0);
  });

  it('POSTs the code in the request body — never in a URL — and refreshes on acceptance', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<PortalGate />);
    await pasteAndSubmit(CODE);

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/portal/session');
    expect(call.init?.method).toBe('POST');
    expect(call.url).not.toContain(CODE);
    expect(String(call.init?.body)).toContain(CODE);
  });

  it('renders the clean refused state with the contract code + requestId on 401', async () => {
    stubFetch(() =>
      jsonResponse(401, {
        error: { code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' },
        requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
      }),
    );
    render(<PortalGate />);
    await pasteAndSubmit(CODE);

    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('This access code was not accepted');
    expect(refused).toHaveTextContent('SESSION_IDLE_EXPIRED');
    expect(refused).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    expect(refused).toHaveTextContent('session idle expired');
    // A refusal never unlocks the portal.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renders the refused state on 403 as well (authenticated but not authorized)', async () => {
    stubFetch(() =>
      jsonResponse(403, {
        error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
        requestId: 'rid-403',
      }),
    );
    render(<PortalGate />);
    await pasteAndSubmit(CODE);
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('AUTH_ACCESS_DENIED');
    expect(refused).toHaveTextContent('rid-403');
  });

  it('renders an honest unreachable state on transport failure — no fake acceptance', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    render(<PortalGate />);
    await pasteAndSubmit(CODE);

    const unreachable = await screen.findByTestId('gate-unreachable');
    expect(unreachable).toHaveTextContent('The API could not be reached');
    expect(unreachable).toHaveTextContent('no access is granted on an unverifiable code');
    expect(refresh).not.toHaveBeenCalled();
  });
});

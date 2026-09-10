import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInForm } from '@/app/(auth)/_components/sign-in-form';

// =============================================================================
// COLLECTOR SIGN-IN GATE (issue #133): the session credential is pasted
// once, POSTed in the request BODY (never a URL), validated against the
// live API server-side, and only then held in the httpOnly
// SameSite=Strict cookie. Every state is rendered honestly; a refusal never
// unlocks the console and never fabricates an acceptance.
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
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
  replace.mockClear();
  refresh.mockClear();
});

async function pasteAndSubmit(credential: string): Promise<void> {
  await userEvent.type(screen.getByLabelText('Session credential'), credential);
  await userEvent.click(screen.getByRole('button', { name: 'Open the console' }));
}

describe('SignInForm', () => {
  it('renders the credential gate with a labelled input and the tokenization contract in plain words', () => {
    render(<SignInForm />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Fuatilia' })).toBeInTheDocument();
    expect(screen.getByLabelText('Session credential')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Open the console' })).toBeEnabled();
    // The cookie contract is disclosed to the collector, in plain words.
    expect(screen.getByText(/HTTP-only, SameSite=Strict cookie/)).toBeInTheDocument();
    expect(screen.getByText(/never placed in a URL/)).toBeInTheDocument();
    // The issuance seam is disclosed too — no username/password pretense.
    expect(screen.getByText(/issues sessions through the auth admin lane/)).toBeInTheDocument();
  });

  it('refuses to submit an empty credential client-side without any network call', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<SignInForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Open the console' }));
    expect(screen.getByTestId('sign-in-local-error')).toHaveTextContent(
      'Paste the session credential your administrator issued.',
    );
    expect(calls).toHaveLength(0);
  });

  it('POSTs the credential in the request body — never in a URL — and lands on the requested dashboard route', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<SignInForm nextHint="%2Fcollections" />);
    await pasteAndSubmit(TOKEN);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });
    expect(replace).toHaveBeenCalledWith('/collections');
    expect(refresh).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/auth/session');
    expect(call.init?.method).toBe('POST');
    expect(call.url).not.toContain(TOKEN);
    expect(String(call.init?.body)).toContain(TOKEN);
  });

  it('falls back to the overview route when the next hint is not a same-origin relative path', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<SignInForm nextHint="//evil.test/grab" />);
    await pasteAndSubmit(TOKEN);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
    expect(calls[0]?.url).not.toContain('evil.test');
  });

  it('shows the submitting state while validating (input locked, no double submit)', async () => {
    const gateRef: { release?: (response: Response) => void } = {};
    const gate = new Promise<Response>((resolve) => {
      gateRef.release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => gate),
    );
    render(<SignInForm />);
    await pasteAndSubmit(TOKEN);

    const button = screen.getByRole('button', { name: 'Validating…' });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Session credential')).toBeDisabled();

    gateRef.release?.(jsonResponse(200, { data: { accepted: true } }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });
  });

  it('renders the clean refused state with the contract code + requestId on 401 and never navigates', async () => {
    stubFetch(() =>
      jsonResponse(401, {
        error: { code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' },
        requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
      }),
    );
    render(<SignInForm nextHint="/collections" />);
    await pasteAndSubmit(TOKEN);

    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('This session credential was not accepted');
    expect(refused).toHaveTextContent('SESSION_IDLE_EXPIRED');
    expect(refused).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    expect(refused).toHaveTextContent('session idle expired');
    // A refusal never unlocks the console.
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renders the refused state on 403 as well (live credential, missing permission)', async () => {
    stubFetch(() =>
      jsonResponse(403, {
        error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
        requestId: 'rid-403',
      }),
    );
    render(<SignInForm />);
    await pasteAndSubmit(TOKEN);
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('AUTH_ACCESS_DENIED');
    expect(refused).toHaveTextContent('rid-403');
    expect(replace).not.toHaveBeenCalled();
  });

  it('renders the refused state with the fallback code when the envelope is unparseable', async () => {
    stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    render(<SignInForm />);
    await pasteAndSubmit(TOKEN);
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('HTTP_INTERNAL_ERROR');
  });

  it('renders an honest unreachable state on transport failure — no fake acceptance', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    render(<SignInForm />);
    await pasteAndSubmit(TOKEN);

    const unreachable = await screen.findByTestId('sign-in-unreachable');
    expect(unreachable).toHaveTextContent('The API could not be reached');
    expect(unreachable).toHaveTextContent('no access is granted on an unverifiable credential');
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never writes the credential to localStorage or sessionStorage', async () => {
    const storageWrites: string[] = [];
    const trackStorage = (store: Storage) => {
      const original = store.setItem.bind(store);
      vi.spyOn(store, 'setItem').mockImplementation((key: string, value: string) => {
        storageWrites.push(`${key}=${value}`);
        return original(key, value);
      });
    };
    trackStorage(window.localStorage);
    trackStorage(window.sessionStorage);

    stubFetch(() => jsonResponse(200, { data: { accepted: true } }));
    render(<SignInForm />);
    await pasteAndSubmit(TOKEN);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledOnce();
    });

    expect(storageWrites).toEqual([]);
  });
});

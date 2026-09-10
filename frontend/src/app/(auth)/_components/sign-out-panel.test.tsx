import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignOutPanel } from '@/app/(auth)/_components/sign-out-panel';

// =============================================================================
// SIGN-OUT (issue #133): the panel asks the server (DELETE /api/auth/session)
// to expire the httpOnly cookie. The credential is never visible here —
// these tests pin the round-trip: request goes out, signed-out state renders,
// failures surface honestly with a retry.
// =============================================================================

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
});

describe('SignOutPanel', () => {
  it('issues DELETE /api/auth/session and renders the signed-out state on success', async () => {
    const { calls } = stubFetch(() => jsonResponse(200, { data: { signedOut: true } }));
    render(<SignOutPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(screen.getByTestId('sign-out-done')).toBeInTheDocument();
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/auth/session');
    expect(call.init?.method).toBe('DELETE');
    // No credential, no query string — the cookie is cleared server-side.
    expect(call.url).not.toContain('?');
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
  });

  it('renders the honest failure state when the request errors, and signing out again succeeds', async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse(200, { data: { signedOut: true } });
    });
    render(<SignOutPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    const failed = await screen.findByTestId('sign-out-failed');
    expect(failed).toHaveTextContent('The sign-out request did not complete');
    expect(screen.getByTestId('sign-out-panel')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(screen.getByTestId('sign-out-done')).toBeInTheDocument();
    });
    expect(attempts).toBe(2);
  });

  it('renders the failure state on a non-OK response instead of claiming success', async () => {
    stubFetch(() => jsonResponse(500, { error: { code: 'HTTP_INTERNAL_ERROR', message: 'x' } }));
    render(<SignOutPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByTestId('sign-out-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-out-done')).not.toBeInTheDocument();
  });

  it('never writes anything to localStorage or sessionStorage during sign-out', async () => {
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

    stubFetch(() => jsonResponse(200, { data: { signedOut: true } }));
    render(<SignOutPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(screen.getByTestId('sign-out-done')).toBeInTheDocument();
    });

    expect(storageWrites).toEqual([]);
  });
});

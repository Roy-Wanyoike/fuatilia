import { SignInForm } from '../_components/sign-in-form';

/**
 * /sign-in — the collector sign-in gate (issue #133).
 *
 * The requested dashboard path arrives as a `next` hint (set by the
 * middleware gate — PATH only, never a credential) and is sanitized
 * open-redirect-safe inside the form before any navigation. The credential
 * itself is POSTed in a JSON body to the same-origin session route; it is
 * never part of this page's URL.
 */

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const nextHint = typeof params.next === 'string' ? params.next : null;
  return <SignInForm nextHint={nextHint} />;
}

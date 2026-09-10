import { Customer360 } from '../_components/customer-360';

/**
 * /customers/[customerId] — the Customer 360 deep view (issue #134). Thin
 * composition over the testable screen component so tests can inject the
 * client + clock deterministically.
 *
 * The /v1 contract mounts no customer directory, so an unknown id cannot be
 * 404'd honestly: the deep view renders its disclosed empty state instead of
 * asserting existence it cannot verify.
 */

function decodeCustomerId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed escape — keep the raw segment; the view's empty states are
    // the honest answer for ids nothing attributes to.
    return raw;
  }
}

export default async function Customer360Page({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  return <Customer360 customerId={decodeCustomerId(customerId)} />;
}

import { BalanceOverview } from '../_components/balance-overview';

/**
 * /portal — balance overview (issue #86 view a). Rendered inside the portal
 * gate: without a validated httpOnly session cookie the route-group layout
 * shows the access-code gate instead of this page.
 */
export default function PortalBalancePage() {
  return <BalanceOverview />;
}

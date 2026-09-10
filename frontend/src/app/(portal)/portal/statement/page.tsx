import { StatementTimeline } from '../../_components/statement-timeline';

/**
 * /portal/statement — statement timeline (issue #86 view c): confirmations,
 * allocations, refunds, reversals and failures from the payment read model.
 */
export default function PortalStatementPage() {
  return <StatementTimeline />;
}

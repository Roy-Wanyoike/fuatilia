import { InvoiceList } from '../../_components/invoice-list';

/**
 * /portal/invoices — invoice list with aging buckets, days past due and
 * state badges (issue #86 view b), from the receivable read model.
 */
export default function PortalInvoicesPage() {
  return <InvoiceList />;
}

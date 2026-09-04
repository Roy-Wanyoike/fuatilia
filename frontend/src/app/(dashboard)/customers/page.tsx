import { EmptyState } from '@/components/ui/empty-state';

/**
 * /customers — the Customer 360 surface (SPEC §47) has no customers
 * operation on /v1 yet: customer ids appear on receivables/payments/cases
 * as opaque cross-lane ids, and there is no customer directory endpoint.
 * No fabricated customer rows.
 */
export default function CustomersPage() {
  return (
    <section aria-labelledby="customers-heading">
      <h1 id="customers-heading" className="text-lg font-semibold text-ink">
        Customers
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        Customer identities currently appear only as opaque ids on the receivable, payment and
        case read models (e.g. <code className="font-mono text-xs">customerId</code>). The /v1
        contract mounts no customer directory yet.
      </p>
      <div className="mt-4 max-w-2xl">
        <EmptyState
          title="No customer directory is mounted on /v1 yet"
          description="api/openapi/fuatilia.v1.yaml has 22 operations; none resolve customer profiles. Customer 360 arrives with the customers lane."
          hint="Until then, per-customer money is traceable via customerId on receivables and payments."
        />
      </div>
    </section>
  );
}

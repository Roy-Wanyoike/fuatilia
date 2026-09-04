import { EmptyState } from '@/components/ui/empty-state';

/**
 * /reconciliation — the matching surface (SPEC §49) has no mounted /v1
 * operation yet (contract capabilities: auth, collections, payments,
 * receivables). This page renders its real emptiness: there is no
 * reconciliation read model to consume, and this lane does not fabricate
 * rows. Unapplied cash is already visible in the Command Center's
 * "Unmatched payments" card.
 */
export default function ReconciliationPage() {
  return (
    <section aria-labelledby="reconciliation-heading">
      <h1 id="reconciliation-heading" className="text-lg font-semibold text-ink">
        Reconciliation
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        Matching (Matched / Suggested / Unmatched / Duplicates / Amount mismatch) needs the
        reconciliation engine&apos;s read model on /v1. The contract&apos;s mounted capabilities
        today are <code className="font-mono text-xs">auth, collections, payments, receivables</code>.
      </p>
      <div className="mt-4 max-w-2xl">
        <EmptyState
          title="No reconciliation surface is mounted on /v1 yet"
          description="api/openapi/fuatilia.v1.yaml documents 22 operations over health, auth admin, receivables, payments and collections cases — none of them reconciliation matches."
          hint="Track the payments-lane follow-up that mounts the reconciliation read model."
        />
      </div>
    </section>
  );
}

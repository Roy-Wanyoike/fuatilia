'use client';

import { EmptyState } from '@/components/ui/empty-state';
import { usePortalT } from '@/lib/portal-i18n/context';

/**
 * /reconciliation — the matching surface (SPEC §49) has no mounted /v1
 * operation yet (contract capabilities: auth, collections, payments,
 * receivables). This page renders its real emptiness: there is no
 * reconciliation read model to consume, and this lane does not fabricate
 * rows. Unapplied cash is already visible in the Command Center's
 * "Unmatched payments" card. Strings resolve through the shared i18n
 * catalogs (issue #180); the mounted capability names stay verbatim —
 * they name the contract.
 */
export default function ReconciliationPage() {
  const t = usePortalT();
  return (
    <section aria-labelledby="reconciliation-heading">
      <h1 id="reconciliation-heading" className="text-lg font-semibold text-ink">
        {t('dashboard.reconciliation.title')}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        {t('dashboard.reconciliation.bodyPrefix')}{' '}
        <code className="font-mono text-xs">{t('dashboard.reconciliation.capabilities')}</code>
        {t('dashboard.reconciliation.bodySuffix')}
      </p>
      <div className="mt-4 max-w-2xl">
        <EmptyState
          title={t('dashboard.reconciliation.emptyTitle')}
          description={t('dashboard.reconciliation.emptyDescription')}
          hint={t('dashboard.reconciliation.emptyHint')}
        />
      </div>
    </section>
  );
}

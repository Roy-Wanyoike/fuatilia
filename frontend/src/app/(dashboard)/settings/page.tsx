'use client';

import { EmptyState } from '@/components/ui/empty-state';
import { usePortalT } from '@/lib/portal-i18n/context';

/**
 * /settings — team, roles, keys and org policy. The contract mounts the
 * auth-admin WRITE operations (users, role grants, api keys, session and
 * key revocations — all `admin:manage-users`) but no READ endpoints to
 * render lists from, and the write path belongs to the actions lane. No
 * fabricated admin tables. Strings resolve through the shared i18n
 * catalogs (issue #180); the permission scope stays verbatim — it names
 * the contract.
 */
export default function SettingsPage() {
  const t = usePortalT();
  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading" className="text-lg font-semibold text-ink">
        {t('dashboard.settings.title')}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        {t('dashboard.settings.bodyPrefix')}{' '}
        <code className="font-mono text-xs">{t('dashboard.settings.scope')}</code>
        {t('dashboard.settings.bodySuffix')}
      </p>
      <div className="mt-4 max-w-2xl">
        <EmptyState
          title={t('dashboard.settings.emptyTitle')}
          description={t('dashboard.settings.emptyDescription')}
          hint={t('dashboard.settings.emptyHint')}
        />
      </div>
    </section>
  );
}

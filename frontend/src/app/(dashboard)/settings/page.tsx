import { EmptyState } from '@/components/ui/empty-state';

/**
 * /settings — team, roles, keys and org policy. The contract mounts the
 * auth-admin WRITE operations (users, role grants, api keys, session and
 * key revocations — all `admin:manage-users`) but no READ endpoints to
 * render lists from, and the write path belongs to the actions lane. No
 * fabricated admin tables.
 */
export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-heading">
      <h1 id="settings-heading" className="text-lg font-semibold text-ink">
        Settings
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        The /v1 contract mounts auth-admin mutations (create user, grant/revoke role, issue/revoke
        API key, revoke session) behind <code className="font-mono text-xs">admin:manage-users</code>,
        but no list/read operations to render management tables from.
      </p>
      <div className="mt-4 max-w-2xl">
        <EmptyState
          title="Settings management arrives with the auth-admin read models"
          description="Until /v1 exposes users/grants/keys read endpoints, administration happens through the API directly; the console renders no substitute data."
          hint="The actions lane will layer react-hook-form + policy-gated mutations onto this page."
        />
      </div>
    </section>
  );
}

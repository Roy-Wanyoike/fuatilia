import { CollectionsScreen } from '@/components/command-center/collections-screen';
import { CaseListView } from './_components/case-list-view';
import { OpenCasePanel } from './_components/open-case-panel';

/**
 * /collections — the collections WORKSPACE (issue #135). The case list and
 * the open-case flow hit the real /v1 contract (list + open); each case row
 * links to the detail screen where the transition / escalation / record
 * action / complete action flows live. The Command Center (issue #76)
 * stays below as the derived read path — both surfaces are fed ONLY by
 * typed query results, so every state they render is real.
 *
 * Thin compositions over testable screen components so tests can inject
 * the clients deterministically.
 */
export default function CollectionsPage() {
  return (
    <div className="space-y-4">
      <section aria-labelledby="collections-workspace-heading">
        <h1 id="collections-workspace-heading" className="text-lg font-semibold text-ink">
          Collections workspace
        </h1>
        <p className="mt-0.5 text-sm text-ink-soft">
          Cases, their state machine, and the collector&apos;s action ladder.
        </p>
      </section>
      <CaseListView />
      <OpenCasePanel />
      <CollectionsScreen />
    </div>
  );
}

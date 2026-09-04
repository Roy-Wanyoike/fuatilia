import { CollectionsScreen } from '@/components/command-center/collections-screen';

/**
 * /collections — the Collections Command Center (issue #76, SPEC §45).
 * A thin composition over the testable screen component so tests can
 * inject the client + clock deterministically.
 */
export default function CollectionsPage() {
  return <CollectionsScreen />;
}

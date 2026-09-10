import { CaseDetailView } from '../_components/case-detail-view';

/**
 * /collections/[caseId] — the case detail route (issue #135). The id comes
 * from the URL path (list rows and the open-case confirmation both link
 * here); the case itself is fetched by the typed client inside the
 * workbench — nothing about the case is trusted from the URL beyond the id
 * (a bad id is a 404 HTTP_CASE_NOT_FOUND envelope, surfaced verbatim).
 */
export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <CaseDetailView caseId={caseId} />;
}

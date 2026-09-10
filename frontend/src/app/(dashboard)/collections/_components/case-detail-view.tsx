'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { defaultClient } from '@/lib/api/browser-client';
import type { ApiResult, FuatiliaClient } from '@/lib/api/client';
import type { CaseView, ReceivableView } from '@/lib/api/wire-types';
import {
  defaultCollectionsClient,
  type CollectionsCaseClient,
} from '@/lib/collections/case-ops';
import { CaseActionLog } from './case-action-log';
import { CaseCompleteActionPanel } from './case-complete-action-panel';
import { CaseEscalationPanel } from './case-escalation-panel';
import { CaseRecordActionPanel } from './case-record-action-panel';
import { CaseSummary, type ReceivablesForCase } from './case-summary';
import { CaseTransitionPanel } from './case-transition-panel';

/**
 * The CASE DETAIL WORKSPACE (issue #135) — GET /v1/collections/cases/
 * {caseId} feeding the four write flows (transition / escalate /
 * record-action / complete-action). Every state on screen is a real query
 * state: skeletons while the case loads, the refusal's code + requestId
 * when the wire refuses (a foreign-org or unknown case answers 404
 * HTTP_CASE_NOT_FOUND — existence never leaks), and no optimistic
 * mutations: the flows replace the case view ONLY with the server's own
 * post-write answer, then re-sync the list read model.
 */

const detailQueryKey = (caseId: string) =>
  ['api', 'collections', 'cases', 'detail', caseId] as const;

export interface CaseDetailViewProps {
  caseId: string;
  /** Read client; defaults to the process-wide browser client (BFF). */
  readClient?: FuatiliaClient;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
}

export function CaseDetailView({
  caseId,
  readClient = defaultClient,
  writeClient = defaultCollectionsClient,
}: CaseDetailViewProps) {
  const queryClient = useQueryClient();

  const caseQuery = useQuery({
    queryKey: detailQueryKey(caseId),
    queryFn: () => readClient.getCase(caseId),
  });

  const caseView = caseQuery.data?.ok === true ? caseQuery.data.data : null;
  const caseRefusal =
    caseQuery.data !== undefined && caseQuery.data.ok === false ? caseQuery.data.refusal : null;

  const receivableIds = caseView?.receivableIds ?? [];
  const receivablesQuery = useQuery({
    queryKey: ['api', 'receivables', 'case-detail', caseView?.id ?? caseId, receivableIds],
    queryFn: async (): Promise<ApiResult<ReceivableView[]>> => {
      // All-or-nothing: a total is only honest when every covered
      // receivable is on the table (mixed/partial money shows no total).
      const results = await Promise.all(
        receivableIds.map((receivableId) => readClient.getReceivable(receivableId)),
      );
      const failed = results.find((result) => !result.ok);
      if (failed !== undefined) return failed;
      const loaded: ReceivableView[] = [];
      for (const result of results) {
        if (result.ok) loaded.push(result.data);
      }
      return { ok: true, data: loaded, pagination: null, requestId: null };
    },
    enabled: caseView !== null,
  });

  /**
   * Replace the case view with the SERVER's post-write answer (never an
   * optimistic invention) and re-sync the list read model so both surfaces
   * stay honest.
   */
  function handleCaseReplaced(nextCase: CaseView, requestId: string | null): void {
    const replaced: ApiResult<CaseView> = {
      ok: true,
      data: nextCase,
      pagination: null,
      requestId,
    };
    queryClient.setQueryData(detailQueryKey(caseId), replaced);
    void queryClient.invalidateQueries({ queryKey: ['api', 'collections', 'cases'] });
  }

  const receivables: ReceivablesForCase =
    receivablesQuery.isPending || receivablesQuery.data === undefined
      ? { phase: 'loading' }
      : receivablesQuery.data.ok === false
        ? {
            phase: 'error',
            refusal: receivablesQuery.data.refusal,
            retry: () => void receivablesQuery.refetch(),
          }
        : { phase: 'loaded', receivables: receivablesQuery.data.data };

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/collections"
          className="text-xs text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ← Back to cases
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-ink" data-testid="case-detail-heading">
          {caseView !== null ? `Case ${caseView.caseNumber}` : 'Case'}
        </h1>
      </div>

      {caseQuery.isPending && (
        <div aria-busy="true" data-testid="case-detail-loading">
          <SkeletonRows rows={5} />
        </div>
      )}

      {!caseQuery.isPending && caseRefusal !== null && (
        <div data-testid="case-detail-error">
          <ErrorState
            title="Couldn't load the case"
            message={refusalMessage(caseRefusal)}
            code={describeRefusalCode(caseRefusal)}
            requestId={refusalRequestId(caseRefusal)}
            onRetry={() => void caseQuery.refetch()}
          />
        </div>
      )}

      {caseView !== null && (
        <div data-testid="case-detail">
          <CaseSummary caseView={caseView} receivables={receivables} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CaseTransitionPanel
              caseView={caseView}
              writeClient={writeClient}
              onCaseReplaced={handleCaseReplaced}
            />
            <CaseEscalationPanel
              caseView={caseView}
              writeClient={writeClient}
              onCaseReplaced={handleCaseReplaced}
            />
          </div>
          <CaseRecordActionPanel
            caseView={caseView}
            writeClient={writeClient}
            onCaseReplaced={handleCaseReplaced}
          />
          <CaseCompleteActionPanel
            caseView={caseView}
            writeClient={writeClient}
            onCaseReplaced={handleCaseReplaced}
          />
          <CaseActionLog caseView={caseView} />
        </div>
      )}
    </div>
  );
}

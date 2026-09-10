'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { defaultClient } from '@/lib/api/browser-client';
import type { FuatiliaClient, Refusal } from '@/lib/api/client';
import type { ReceivableView } from '@/lib/api/wire-types';
import { formatMoney } from '@/lib/money';
import {
  defaultCollectionsClient,
  type CollectionsCaseClient,
} from '@/lib/collections/case-ops';
import { CASE_PRIORITIES } from '@/lib/api/wire-types';
import { usePortalT } from '@/lib/portal-i18n/context';

/**
 * The OPEN-CASE flow (issue #135) — POST /v1/collections/cases over one or
 * more receivables. Receivables are picked from the REAL read model
 * (GET /v1/receivables, bounded first page) — no fabricated rows; the
 * collector can also paste an id that has not synced into the picker yet.
 * R8 exclusivity is the server's decision: a 409 CASE_ALREADY_OPEN envelope
 * (naming the covering case) surfaces verbatim with code + requestId.
 * Strings resolve through the shared i18n catalogs (issue #180); the
 * priority enum stays a wire value.
 */

const RECEIVABLES_QUERY_KEY = ['api', 'receivables', 'open-case-picker'] as const;

export interface OpenCasePanelProps {
  /** Read client (receivables); defaults to the process-wide browser client. */
  readClient?: FuatiliaClient;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
}

type PanelPhase = 'idle' | 'submitting' | 'opened' | 'refused';

export function OpenCasePanel({
  readClient = defaultClient,
  writeClient = defaultCollectionsClient,
}: OpenCasePanelProps) {
  const t = usePortalT();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [pastedIds, setPastedIds] = useState('');
  const [collectorId, setCollectorId] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [openedCase, setOpenedCase] = useState<{ id: string; caseNumber: string } | null>(null);

  const receivablesQuery = useQuery({
    queryKey: RECEIVABLES_QUERY_KEY,
    queryFn: () => readClient.listReceivables({ limit: 50, sort: 'dueDate', order: 'asc' }),
    enabled: expanded,
  });

  const rows: ReceivableView[] =
    receivablesQuery.data?.ok === true ? receivablesQuery.data.data.rows : [];

  function toggle(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function mergedIds(): string[] {
    const pasted = pastedIds
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return Array.from(new Set([...selected, ...pasted]));
  }

  function reset(): void {
    setSelected([]);
    setPastedIds('');
    setCollectorId('');
    setPriority('normal');
    setPhase('idle');
    setRefusal(null);
    setLocalError(null);
    setOpenedCase(null);
  }

  async function submit(): Promise<void> {
    const receivableIds = mergedIds();
    const trimmedCollector = collectorId.trim();
    if (receivableIds.length === 0) {
      setLocalError(t('dashboard.collections.open.localErrorNoIds'));
      return;
    }
    if (trimmedCollector.length === 0) {
      setLocalError(t('dashboard.collections.open.localErrorCollector'));
      return;
    }
    setLocalError(null);
    setRefusal(null);
    setPhase('submitting');
    const result = await writeClient.openCase({
      receivableIds,
      collectorId: trimmedCollector,
      priority,
    });
    if (result.ok) {
      setOpenedCase({ id: result.data.id, caseNumber: result.data.caseNumber });
      setPhase('opened');
      // The read model is truth: refetch every case list so the new case
      // appears without optimistic insertion.
      await queryClient.invalidateQueries({ queryKey: ['api', 'collections', 'cases'] });
      return;
    }
    setRefusal(result.refusal);
    setPhase('refused');
  }

  return (
    <Card aria-labelledby="open-case-heading">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle id="open-case-heading" className="text-base">
            {t('dashboard.collections.open.title')}
          </CardTitle>
          <CardDescription>
            {t('dashboard.collections.open.description')}
          </CardDescription>
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={expanded}
          aria-controls="open-case-body"
          onClick={() => {
            setExpanded((value) => !value);
            setPhase('idle');
            setRefusal(null);
            setLocalError(null);
            setOpenedCase(null);
          }}
        >
          {expanded ? t('dashboard.collections.open.hide') : t('dashboard.collections.open.toggle')}
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent id="open-case-body">
          {phase === 'opened' && openedCase !== null && (
            <div
              role="status"
              className="rounded-md border border-ok-soft bg-ok-soft/40 px-4 py-3 text-sm"
              data-testid="open-case-success"
            >
              <p className="font-medium text-ok">
                {t('dashboard.collections.open.success', { caseNumber: openedCase.caseNumber })}
              </p>
              <Link
                href={`/collections/${encodeURIComponent(openedCase.id)}`}
                className="font-mono text-xs text-accent underline-offset-2 hover:underline"
              >
                {t('dashboard.collections.open.workTheCase')}
              </Link>
            </div>
          )}

          {phase === 'refused' && refusal !== null && (
            <div className="mb-3">
              <ErrorState
                title={t('dashboard.collections.open.refusedTitle')}
                message={refusalMessage(refusal)}
                code={describeRefusalCode(refusal)}
                requestId={refusalRequestId(refusal)}
              />
            </div>
          )}

          {expanded && phase !== 'opened' && (
            <div className="space-y-4">
              <fieldset>
                <legend className="text-sm font-medium text-ink">{t('dashboard.collections.open.receivablesLegend')}</legend>
                {receivablesQuery.isPending && (
                  <div aria-busy="true" className="mt-2" data-testid="open-case-receivables-loading">
                    <SkeletonRows rows={2} />
                  </div>
                )}
                {receivablesQuery.data !== undefined && !receivablesQuery.data.ok && (
                  <div className="mt-2">
                    <ErrorState
                      title={t('dashboard.collections.open.pickerRefusedTitle')}
                      message={refusalMessage(receivablesQuery.data.refusal)}
                      code={describeRefusalCode(receivablesQuery.data.refusal)}
                      requestId={refusalRequestId(receivablesQuery.data.refusal)}
                      onRetry={() => void receivablesQuery.refetch()}
                    />
                  </div>
                )}
                {receivablesQuery.data?.ok === true && rows.length === 0 && (
                  <p className="mt-2 text-xs text-ink-soft" data-testid="open-case-receivables-empty">
                    {t('dashboard.collections.open.pickerEmpty')}
                  </p>
                )}
                {rows.length > 0 && (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
                    {rows.map((receivable) => (
                      <li key={receivable.id}>
                        <label className="flex items-center gap-2 text-xs text-ink">
                          <input
                            type="checkbox"
                            checked={selected.includes(receivable.id)}
                            onChange={() => toggle(receivable.id)}
                            className="h-3.5 w-3.5"
                          />
                          <span className="font-mono">{receivable.id}</span>
                          <span className="text-ink-soft">
                            {formatMoney(receivable.balance)} · {receivable.state}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor="open-case-collector" className="text-sm font-medium text-ink">
                    {t('dashboard.collections.open.collectorIdLabel')}
                  </label>
                  <input
                    id="open-case-collector"
                    type="text"
                    value={collectorId}
                    onChange={(event) => setCollectorId(event.target.value)}
                    placeholder={t('dashboard.collections.open.collectorIdPlaceholder')}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                </div>
                <div>
                  <label htmlFor="open-case-priority" className="text-sm font-medium text-ink">
                    {t('dashboard.collections.open.priorityLabel')}
                  </label>
                  <select
                    id="open-case-priority"
                    value={priority}
                    onChange={(event) =>
                      setPriority(event.target.value as 'low' | 'normal' | 'high' | 'urgent')
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {CASE_PRIORITIES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {candidate}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="open-case-pasted" className="text-sm font-medium text-ink">
                  {t('dashboard.collections.open.additionalIdsLabel')}
                </label>
                <input
                  id="open-case-pasted"
                  type="text"
                  value={pastedIds}
                  onChange={(event) => setPastedIds(event.target.value)}
                  placeholder={t('dashboard.collections.open.additionalIdsPlaceholder')}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 font-mono text-xs text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
              </div>

              {localError !== null && (
                <p role="alert" className="text-xs text-danger" data-testid="open-case-local-error">
                  {localError}
                </p>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={() => void submit()} disabled={phase === 'submitting'}>
                  {phase === 'submitting'
                    ? t('dashboard.collections.open.submitting')
                    : t('dashboard.collections.open.submit')}
                </Button>
                {phase !== 'submitting' && (
                  <Button variant="ghost" size="sm" onClick={reset}>
                    {t('dashboard.collections.open.reset')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaseSummary, type ReceivablesForCase } from './case-summary';
import { specCase } from '@/lib/api/fixtures/collections';
import {
  specReceivable,
  syntheticReceivableDueToday,
} from '@/lib/api/fixtures/receivables';
import type { Refusal } from '@/lib/api/client';
import type { ReceivableView } from '@/lib/api/wire-types';

// =============================================================================
// CASE SUMMARY (issue #135): the three state-machine badges, the lifecycle
// facts, and money rendered from integer minor units via lib/money — with
// honest rules for loading, refusal, and a total that only exists when the
// balances actually support one.
// =============================================================================

afterEach(() => {
  cleanup();
});

const loadedWith = (receivables: ReceivableView[]): ReceivablesForCase => ({
  phase: 'loaded',
  receivables,
});

describe('CaseSummary badges and facts', () => {
  it('renders the state-machine badges and lifecycle facts', () => {
    render(
      <CaseSummary
        caseView={specCase}
        receivables={{ phase: 'loading' }}
      />,
    );
    expect(screen.getByTestId('case-status-badge')).toHaveTextContent('Open');
    expect(screen.getByTestId('case-derived-badge')).toHaveTextContent('waiting');
    expect(screen.getByTestId('case-priority-badge')).toHaveTextContent('high');
    expect(screen.getByText('CASE-000007')).toBeInTheDocument();
    expect(screen.getByText(specCase.collectorId)).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // covered receivables count
  });

  it('shows the closed facts only for a closed case', () => {
    render(
      <CaseSummary
        caseView={{
          ...specCase,
          status: 'closed_inactive',
          closedAt: '2026-09-05T10:00:00.000Z',
          closedBy: specCase.collectorId,
        }}
        receivables={{ phase: 'loading' }}
      />,
    );
    expect(screen.getByText('2026-09-05 13:00')).toBeInTheDocument(); // Nairobi wall time
    expect(screen.getByText('Closed by')).toBeInTheDocument();
    // The closer id appears twice: the collector fact and the closedBy row.
    expect(screen.getAllByText(specCase.collectorId)).toHaveLength(2);
  });
});

describe('CaseSummary money (lib/money, exact minor units)', () => {
  it('renders the spec balances exactly and totals one-currency coverage', () => {
    render(
      <CaseSummary
        caseView={specCase}
        receivables={loadedWith([specReceivable])}
      />,
    );
    const rows = screen.getAllByTestId('case-receivable-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('KES 75,000.00'); // minor 7,500,000 → exact
    expect(rows[0]).toHaveTextContent('partially_paid · overdue');
    expect(screen.getByTestId('case-balance-total')).toHaveTextContent(
      'Outstanding: KES 75,000.00',
    );
    expect(screen.queryByTestId('case-money-unavailable')).not.toBeInTheDocument();
  });

  it('sums same-currency balances exactly (no float math)', () => {
    render(
      <CaseSummary
        caseView={specCase}
        receivables={loadedWith([specReceivable, syntheticReceivableDueToday])}
      />,
    );
    expect(screen.getByTestId('case-balance-total')).toHaveTextContent(
      'Outstanding: KES 150,000.00',
    );
  });

  it('refuses to invent a total across currencies — count stays visible', () => {
    render(
      <CaseSummary
        caseView={specCase}
        receivables={loadedWith([
          specReceivable,
          { ...specReceivable, id: 'bb0b0b0b-0000-4000-8000-0000000000aa', balance: { minor: 100, currency: 'USD' } },
        ])}
      />,
    );
    expect(screen.queryByTestId('case-balance-total')).not.toBeInTheDocument();
    expect(screen.getByTestId('case-money-unavailable')).toHaveTextContent('No single total');
    expect(screen.getAllByTestId('case-receivable-row')).toHaveLength(2);
  });
});

describe('CaseSummary receivables states', () => {
  it('shows an honest loading state (no invented rows)', () => {
    render(
      <CaseSummary caseView={specCase} receivables={{ phase: 'loading' }} />,
    );
    expect(screen.getByTestId('case-summary-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('case-receivable-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('case-balance-total')).not.toBeInTheDocument();
  });

  it('surfaces the receivables refusal with code + requestId and a retry', () => {
    const refusal: Refusal = {
      tag: 'api-error',
      status: 404,
      code: 'HTTP_RECEIVABLE_NOT_FOUND',
      message: 'receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4 does not exist',
      requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
    };
    const retry = vi.fn();
    render(
      <CaseSummary
        caseView={specCase}
        receivables={{ phase: 'error', refusal, retry }}
      />,
    );
    const alert = screen.getByTestId('case-summary-receivables-error').querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('code: HTTP_RECEIVABLE_NOT_FOUND');
    expect(alert).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
  });
});

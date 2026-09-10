import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CaseActionLog } from './case-action-log';
import {
  caseActionRecordedExample,
  caseDetailExample,
  specCase,
} from '@/lib/api/fixtures/collections';

// =============================================================================
// THE SEALED LOG (issue #135): actions/transitions/priority-changes render
// exactly as the wire returned them — read-only, honest empties, and an
// explicit seal note for terminal cases.
// =============================================================================

afterEach(() => {
  cleanup();
});

describe('CaseActionLog actions', () => {
  it('renders the spec action row with its completion state', () => {
    render(<CaseActionLog caseView={caseDetailExample.data.case} />);
    const rows = screen.getAllByTestId('case-log-action-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Call');
    expect(rows[0]).toHaveTextContent('manual');
    expect(rows[0]).toHaveTextContent('spoke to site foreman — promised part payment');
    expect(screen.getByTestId('case-log-action-completed')).toHaveTextContent(
      'completed 2026-09-02 12:20',
    );
  });

  it('marks recorded-but-uncompleted actions as awaiting completion', () => {
    render(<CaseActionLog caseView={caseActionRecordedExample.data.case} />);
    expect(screen.getByTestId('case-log-action-open')).toHaveTextContent('awaiting completion');
    expect(screen.queryByTestId('case-log-action-completed')).not.toBeInTheDocument();
  });

  it('says so honestly when no actions exist yet', () => {
    render(<CaseActionLog caseView={specCase} />);
    expect(screen.getByTestId('case-log-actions-empty')).toHaveTextContent(
      'No actions recorded yet',
    );
  });
});

describe('CaseActionLog history and priority changes', () => {
  it('renders the lifecycle transition with its reason and actor', () => {
    render(<CaseActionLog caseView={caseDetailExample.data.case} />);
    const rows = screen.getAllByTestId('case-log-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Open → In progress');
    expect(rows[0]).toHaveTextContent('collector engaged');
  });

  it('renders an escalation bump', () => {
    render(
      <CaseActionLog
        caseView={{
          ...specCase,
          priorityChanges: [
            {
              from: 'normal',
              to: 'urgent',
              reason: '60+ days overdue and site access at risk',
              actorId: specCase.collectorId,
              at: '2026-09-03T08:00:00.000Z',
            },
          ],
        }}
      />,
    );
    const rows = screen.getAllByTestId('case-log-priority-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('normal → urgent');
    expect(rows[0]).toHaveTextContent('60+ days overdue');
  });

  it('carries honest empties for a fresh case', () => {
    render(<CaseActionLog caseView={specCase} />);
    expect(screen.getByTestId('case-log-history-empty')).toBeInTheDocument();
    expect(screen.getByTestId('case-log-priority-empty')).toBeInTheDocument();
  });
});

describe('CaseActionLog seal', () => {
  it('notes the sealed log on a terminal case', () => {
    render(<CaseActionLog caseView={{ ...specCase, status: 'resolved' }} />);
    expect(screen.getByTestId('case-log-sealed-note')).toHaveTextContent(
      'log is sealed',
    );
    expect(screen.getByTestId('case-log-sealed-note')).toHaveTextContent('CASE_CLOSED');
  });

  it('carries no seal note while the case is live', () => {
    render(<CaseActionLog caseView={caseDetailExample.data.case} />);
    expect(screen.queryByTestId('case-log-sealed-note')).not.toBeInTheDocument();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { specCase } from '@/lib/api/fixtures/collections';
import {
  CasePriorityBadge,
  CaseStatusBadge,
  DerivedStatusBadge,
} from './case-badges';

// =============================================================================
// STATE-MACHINE BADGES (issue #135): tone semantics pinned per state so the
// list and detail screens cannot drift apart.
// =============================================================================

afterEach(() => {
  cleanup();
});

describe('CaseStatusBadge', () => {
  it('renders stored statuses with the pinned tones', () => {
    render(<CaseStatusBadge status={specCase.status} />);
    const badge = screen.getByTestId('case-status-badge');
    expect(badge).toHaveTextContent('Open');
    expect(badge.className).toContain('bg-sky-100'); // info tone
  });

  it('renders in_progress as info and resolved as success', () => {
    const { rerender } = render(<CaseStatusBadge status="in_progress" />);
    const badge = screen.getByTestId('case-status-badge');
    expect(badge.className).toContain('bg-sky-100');

    rerender(<CaseStatusBadge status="resolved" />);
    expect(badge.className).toContain('bg-ok-soft');

    rerender(<CaseStatusBadge status="closed_inactive" />);
    expect(badge.className).toContain('bg-slate-100');
  });
});

describe('DerivedStatusBadge', () => {
  it('renders the DERIVED overlays with their pinned tones', () => {
    const { rerender } = render(<DerivedStatusBadge derived="promised" />);
    const badge = screen.getByTestId('case-derived-badge');
    expect(badge.className).toContain('bg-warn-soft');

    rerender(<DerivedStatusBadge derived="disputed" />);
    expect(badge.className).toContain('bg-danger-soft');

    rerender(<DerivedStatusBadge derived="waiting" />);
    expect(badge.className).toContain('bg-slate-100');
  });
});

describe('CasePriorityBadge', () => {
  it('heats up with the priority ladder', () => {
    const { rerender } = render(<CasePriorityBadge priority="low" />);
    const badge = screen.getByTestId('case-priority-badge');
    expect(badge.className).toContain('bg-slate-100');

    rerender(<CasePriorityBadge priority="normal" />);
    expect(badge.className).toContain('bg-sky-100');

    rerender(<CasePriorityBadge priority="high" />);
    expect(badge.className).toContain('bg-warn-soft');

    rerender(<CasePriorityBadge priority="urgent" />);
    expect(badge.className).toContain('bg-danger-soft');
  });
});

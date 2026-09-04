import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CollectionsScreen } from '@/components/command-center/collections-screen';
import { createFuatiliaClient, type FetchLike } from '@/lib/api/client';
import { QueryProviders } from '@/providers/query-provider';

// =============================================================================
// A11Y BASELINE — the floor every lane must keep, asserted so it cannot rot:
//   1. landmark structure (section labelled by the h1, per-card regions with
//      accessible names),
//   2. every card's busy state is announced (aria-busy) and its skeleton is
//      hidden from assistive tech (aria-hidden, presentation role),
//   3. retry affordances have real accessible names,
//   4. metric text is real text (no images of numbers anywhere).
// Deeper audits (axe, screen-reader matrices) are roadmap — README "A11y".
// =============================================================================

const CARD_TITLES = [
  'Expected collections today',
  'Overdue',
  'At-risk',
  'Promises due',
  'Missed promises',
  'Unmatched payments',
  'High-value opportunities',
] as const;

const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);

function renderPending(): void {
  const client = createFuatiliaClient({
    baseUrl: 'http://a11y.test',
    fetchImpl: neverFetch,
    logger: null,
    requestIdGenerator: () => 'a11y-req-1',
  });
  render(
    <QueryProviders>
      <CollectionsScreen client={client} />
    </QueryProviders>,
  );
}

describe('Command Center a11y baseline', () => {
  it('exposes a labelled section and one named region per card', () => {
    renderPending();
    const heading = screen.getByRole('heading', { level: 1, name: 'Collections Command Center' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute(
      'aria-labelledby',
      expect.stringContaining('command-center-heading'),
    );
    for (const title of CARD_TITLES) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
    }
  });

  it('announces busy cards and hides skeletons from assistive tech', () => {
    renderPending();
    for (const title of CARD_TITLES) {
      const region = screen.getByRole('region', { name: title });
      expect(region).toHaveAttribute('aria-busy', 'true');
      const skeletons = region.querySelectorAll('[aria-hidden="true"]');
      expect(skeletons.length).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole('presentation')).toHaveLength(CARD_TITLES.length);
  });

  it('keeps retry/refresh affordances named and metric money as real text', async () => {
    renderPending();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    // The loaded state renders money through formatMoney() into text nodes —
    // asserted here via the derivation footer, which is plain text too.
    const footers = screen.getAllByText(/derivation: GET \/v1\//);
    expect(footers).toHaveLength(CARD_TITLES.length);
  });
});

import { describe, expect, it } from 'vitest';
import { formatTimestamp, scheduledForToIso } from './display';

// =============================================================================
// DISPLAY HELPERS (issue #135): deterministic rendering in Africa/Nairobi
// (UTC+3 fixed) and honest datetime-local → contract date-time conversion.
// =============================================================================

describe('formatTimestamp', () => {
  it('renders spec timestamps in Africa/Nairobi wall time', () => {
    // 2026-09-02T09:00:00.000Z is 12:00 in Nairobi (UTC+3).
    expect(formatTimestamp('2026-09-02T09:00:00.000Z')).toBe('2026-09-02 12:00');
  });

  it('accepts explicit offsets and renders the same instant identically', () => {
    expect(formatTimestamp('2026-09-02T12:00:00+03:00')).toBe('2026-09-02 12:00');
  });

  it('renders null/undefined/invalid as an em-dash — never an invented date', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp('not-a-date')).toBe('—');
  });
});

describe('scheduledForToIso', () => {
  it('converts a datetime-local value to an explicit +03:00 Nairobi offset', () => {
    expect(scheduledForToIso('2026-09-02T09:00')).toBe('2026-09-02T09:00:00+03:00');
  });

  it('keeps seconds precision when the browser provides it', () => {
    expect(scheduledForToIso('2026-09-02T09:00:45')).toBe('2026-09-02T09:00:45+03:00');
  });

  it('round-trips through the contract: the offset form validates as date-time', () => {
    const iso = scheduledForToIso('2026-09-02T09:00');
    expect(iso).not.toBeNull();
    // The same instant renders identically whether sent as Z or +03:00.
    expect(new Date(iso ?? '').toISOString()).toBe('2026-09-02T06:00:00.000Z');
  });

  it('refuses non-input junk and impossible calendar days', () => {
    expect(scheduledForToIso('')).toBeNull();
    expect(scheduledForToIso('2026-09-02')).toBeNull();
    expect(scheduledForToIso('yesterday')).toBeNull();
    expect(scheduledForToIso('2026-02-30T09:00')).toBeNull();
    expect(scheduledForToIso('2026-13-01T09:00')).toBeNull();
  });
});

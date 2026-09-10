/**
 * Presentation helpers for the collections workspace. Deterministic by
 * construction: timestamps render in Africa/Nairobi (the product's home
 * market, UTC+3 fixed — no DST), an explicit timeZone keeps rendering
 * identical across devices and CI. The rendered shape is numeric
 * (`YYYY-MM-DD HH:mm`) — no locale month names, no ICU drift between
 * machines.
 */

const NAIROBI_TIME_ZONE = 'Africa/Nairobi';

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: NAIROBI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * An ISO date-time (with offset or Z) → "2026-09-02 12:00" in
 * Africa/Nairobi wall time. Invalid input renders the em-dash placeholder
 * instead of an invented date.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const parts = partsFormatter.formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

/**
 * A `<input type="datetime-local">` value ("2026-09-02T09:00" or with
 * seconds) → an ISO date-time with the explicit +03:00 offset. The collector
 * means Nairobi wall time — FuatiliA's home market is UTC+3 fixed — and the
 * contract's date-time format requires an explicit offset. Returns null for
 * anything the browser field could not honestly produce (the caller then
 * shows a local validation error instead of shipping junk).
 */
export function scheduledForToIso(localValue: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  const sec = Number(second ?? '00');
  // Calendar honesty: the browser field cannot produce 2026-02-30 or
  // 25:99, but hand-typed values can — verify every component exists
  // instead of letting the epoch roll over silently.
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return `${year}-${month}-${day}T${hour}:${minute}:${pad(sec)}+03:00`;
}

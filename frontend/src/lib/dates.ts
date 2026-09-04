/**
 * Day-boundary helpers. FuatiliA's home market is Kenya (Africa/Nairobi,
 * UTC+3, no DST), so "today" means the Africa/Nairobi calendar day. The
 * computation uses ICU tz data via Intl (no date library, no float epoch
 * math): each instant is reduced to its `YYYY-MM-DD` Nairobi calendar key
 * and keys are compared lexicographically.
 */

const NAIROBI_TIME_ZONE = 'Africa/Nairobi';

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NAIROBI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` calendar key of `at` in Africa/Nairobi. */
export function nairobiDayKey(at: Date): string {
  return dayKeyFormatter.format(at);
}

/** Same Nairobi calendar day? */
export function isSameNairobiDay(a: Date, b: Date): boolean {
  return nairobiDayKey(a) === nairobiDayKey(b);
}

/** Is `candidate` on a STRICTLY EARLIER Nairobi calendar day than `reference`? */
export function isBeforeNairobiDay(candidate: Date, reference: Date): boolean {
  return nairobiDayKey(candidate) < nairobiDayKey(reference);
}

/** Is `candidate` on the same or an earlier Nairobi calendar day? */
export function isOnOrBeforeNairobiDay(candidate: Date, reference: Date): boolean {
  return nairobiDayKey(candidate) <= nairobiDayKey(reference);
}

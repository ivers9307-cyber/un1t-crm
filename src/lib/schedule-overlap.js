// SCHEDULE-DOUBLE-BOOKING.1 — pure helpers for the double-booking advisory,
// plus (ROSTER-FIX.6c) the time formatting every schedule screen shares.
//
// A coach physically can't be at two shifts at once, so when an
// assignment overlaps another shift the coach is already on (same date,
// ANY location), we surface a warning. Advisory, not a hard block — same
// posture as the existing time-off warning, since a coach legitimately
// "floats" across adjacent slots sometimes and the operator is the judge.

/** 'HH:MM:SS' → 'HH:MM'. Pure. */
export function fmtTime(t) {
  return String(t || '').slice(0, 5)
}

/**
 * ROSTER-FIX.6c — 'HH:MM:SS' → the 12-hour label the schedule screens render
 * ('9am', '9:30am', '12pm'). Pure.
 *
 * This is NOT fmtTime with a different skin: fmtTime returns the 24-hour
 * 'HH:MM' the overlap comparison needs, and it is what a clash badge quotes.
 * The 12-hour form is what the calendar, the template manager and the swap
 * list have always PRINTED on a card, and those three each carried their own
 * byte-identical copy of it. One copy now, in the module that already owns
 * schedule time formatting, so the two forms sit side by side and the reason
 * there are two is written down instead of guessed at.
 */
export function formatTime12h(time) {
  if (!time) return ''
  const [h, m] = String(time).split(':')
  const hour = parseInt(h)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour
  return m === '00' ? `${display}${suffix}` : `${display}:${m}${suffix}`
}

/**
 * Do two same-day time ranges overlap? Pure. Compares at minute
 * granularity ('HH:MM') — lexical comparison is correct for zero-padded
 * same-day times. Touching endpoints (one ends exactly when the other
 * starts) do NOT count as an overlap. Zero-length or overnight ranges
 * (end <= start) are out of scope (gym shifts don't cross midnight) and
 * return false to avoid false positives.
 */
export function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = fmtTime(aStart)
  const ae = fmtTime(aEnd)
  const bs = fmtTime(bStart)
  const be = fmtTime(bEnd)
  if (!as || !ae || !bs || !be) return false
  if (ae <= as || be <= bs) return false
  return as < be && bs < ae
}

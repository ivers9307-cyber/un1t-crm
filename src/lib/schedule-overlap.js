// SCHEDULE-DOUBLE-BOOKING.1 — pure helpers for the double-booking advisory.
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

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

/**
 * ROSTER-FIX.6c — what the assign picker should warn about before a coach is
 * ticked. Pure, so the modal can call it once per row in a render.
 *
 * Two advisories, both of them things the operator can already see somewhere
 * else on the screen and could not see in the one place the decision is made:
 *
 *   clash   the coach already has a LIVE assignment that day whose effective
 *           window overlaps this block's. Effective means the assignment's own
 *           start/end override when it has one, the block's times otherwise -
 *           the same window the calendar prints on the card, so the badge and
 *           the grid cannot disagree.
 *   onLeave an APPROVED time_off_requests row covers the block's date. The
 *           status is re-checked here rather than trusted from the caller's
 *           query: this helper is the thing that says "on leave", so it should
 *           not be able to say it about a request nobody has approved.
 *
 * ADVISORY ONLY. Same posture as the server's double-booking warning: a coach
 * legitimately covers two adjacent slots, and a manager staffing a studio is
 * the judge of that. Nothing here disables a row.
 *
 * Scope is honest about its inputs: `blocks` is whatever the caller holds,
 * which on the calendar is one location's visible range. A clash at ANOTHER
 * studio is not detectable client-side and is not claimed to be - the server
 * warning on POST /assignments still covers that case.
 *
 * @param {object} args
 * @param {string} args.coachId    profiles.id being considered
 * @param {object} args.block      the shift_blocks row being staffed
 * @param {object[]} [args.blocks] blocks in hand, including `block` itself
 * @param {object[]} [args.timeOff] time_off_requests rows in hand
 * @returns {{ clash: null | { blockId: string, name: string, startTime: string, endTime: string }, onLeave: boolean }}
 */
export function coachConflictsForBlock({ coachId, block, blocks, timeOff }) {
  const none = { clash: null, onLeave: false }
  if (!coachId || !block?.block_date) return none

  const date = block.block_date
  const targetStart = block.start_time
  const targetEnd = block.end_time

  let clash = null
  for (const other of blocks || []) {
    if (!other || other.id === block.id) continue
    if (other.block_date !== date) continue
    for (const a of other.shift_assignments || []) {
      if (a?.profile_id !== coachId) continue
      // ROSTER-FIX.1's one definition of live, inlined rather than imported so
      // this module stays free of a dependency on the roster lib.
      if (a.status === 'cancelled') continue
      const start = a.start_time_override || other.start_time
      const end = a.end_time_override || other.end_time
      if (!timeRangesOverlap(targetStart, targetEnd, start, end)) continue
      clash = {
        blockId: other.id,
        name: other.shift_templates?.name || 'Shift',
        startTime: fmtTime(start),
        endTime: fmtTime(end),
      }
      break
    }
    if (clash) break
  }

  const onLeave = (timeOff || []).some((t) => (
    t?.profile_id === coachId
    && t.status === 'approved'
    && t.start_date <= date
    && t.end_date >= date
  ))

  return { clash, onLeave }
}

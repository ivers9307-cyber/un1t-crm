// UN1TMOVE.2 — the late-window move rule (Richard, 28 Oct 2026), a studio fee
// policy for un1t.online class bookings:
//
//   1. When leaving the booked class falls inside the studio's late-cancel
//      window (the FEES.2 rule: lateCancelQuote says a late cancel would cost
//      a fee or the credit), the booking may move only to a class on the SAME
//      calendar day as the class it leaves, on the studio's own clock.
//   2. A booking moved inside that window can never be cancelled by the CRM
//      afterwards (move to a later class the same day, then cancel, is how a
//      fee would be dodged).
//
// Rule 2 is read from the ledger the CRM already writes: the move attempt row
// in un1t_write_events carries late_window = true (mig 786), its target is
// the booking it moved and, once done, its un1t_ref is the booking id
// un1t.online answered with. Pure helpers and one read; no write module is
// imported, so Mia's modules may use it.

import { dateKeyIn } from './location-time.js'

/** The codes the rule answers with (moveBooking's and cancel's refusals). */
export const UN1T_LATE_MOVE_CODES = Object.freeze({
  // Inside the window, to a class on another day: refused, nothing sent.
  OTHER_DAY: 'move_late_other_day',
  // The window could not be worked out: refused (retryable), nothing sent.
  WINDOW_UNREADABLE: 'move_window_unreadable',
  // The booking was moved inside the window: never cancelled by the CRM.
  CANCEL_AFTER_LATE_MOVE: 'cancel_after_late_move',
  // Whether it was could not be read: refused (retryable), nothing sent.
  CANCEL_CHECK_UNREADABLE: 'cancel_late_move_unreadable',
})

/**
 * Do two instants fall on the same calendar day in `zone`? false when either
 * cannot be read. Pure.
 */
export function sameStudioDay(a, b, zone) {
  const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v ?? ''))
  const am = ms(a)
  const bm = ms(b)
  if (!Number.isFinite(am) || !Number.isFinite(bm)) return false
  return dateKeyIn(am, zone) === dateKeyIn(bm, zone)
}

// A move that is done, or still in flight or in doubt (it may have landed),
// counts. A refused one moved nothing.
const HOLDING_STAGES = ['sent', 'unknown', 'done']

/**
 * Was this booking moved inside the late-cancel window? The move rows that
 * name it as the booking they moved (target) or the booking un1t.online
 * answered with (un1t_ref).
 *
 * THROWS on a database error, and every cancel path refuses on a throw (fail
 * closed): a cancel the CRM did not send is recoverable by staff in the
 * un1t.online console, a fee dodged by a cancel is not.
 * @returns {Promise<boolean>}
 */
export async function wasMovedInLateWindow(db, { locationId, bookingId }) {
  if (!locationId || !bookingId) throw new TypeError('wasMovedInLateWindow: locationId and bookingId are required')
  for (const column of ['target', 'un1t_ref']) {
    const { data, error } = await db
      .from('un1t_write_events')
      .select('id')
      .eq('location_id', locationId)
      .eq('op', 'move')
      .eq('late_window', true)
      .eq(column, bookingId)
      .in('stage', HOLDING_STAGES)
      .limit(1)
    if (error) throw Object.assign(new Error(`un1t_write_events late-move read failed (${error.code ?? 'no code'})`), { code: error.code ?? null })
    if (Array.isArray(data) && data.length > 0) return true
  }
  return false
}

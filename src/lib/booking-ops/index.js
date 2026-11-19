// bookingOpsFor — one way to book and cancel a class, whichever membership
// platform the studio runs on (BOOKINGOPS.1).
//
// The read side already has one dispatcher (src/lib/membership/reads); writes
// did not, so every caller judged Glofox's and un1t.online's answers in its
// own way. Each adapter here takes a context and the request, and answers in
// ONE shape:
//
//   { verdict: 'done' | 'refused' | 'unknown', id, alreadyBooked, code, message, retryable, raw }
//
//   done       the class is booked (or cancelled). alreadyBooked: the person
//              was already in it, which is success, not a failure.
//   refused    the platform said no; `code` says why.
//   unknown    the platform's answer never arrived or was unreadable
//              (un1t.online only today; Glofox reports a 5xx as refused).
//   raw        the platform's own answer, for the caller's response copy.
//
// What stays OUTSIDE the adapter, on purpose, for now: picking the platform
// (the processor still picks Glofox by credentials), the credit and balance
// checks each platform needs before a booking, and how a route words its
// answer. Moves exist only on un1t.online (`canMove`); on Glofox a move is a
// cancel then a book.
//
//   const ops = bookingOpsFor('glofox')
//   const r = await ops.book({ creds }, { glofoxMemberId, eventId })

import { createBooking, cancelBooking, interpretBookingResult, GLOFOX_BOOKING_MODEL } from '@/lib/glofox'
import { book as un1tBook, cancel as un1tCancel, moveBooking as un1tMove } from '@/lib/un1t-online-write-ops'

const glofoxOps = Object.freeze({
  platform: 'glofox',
  canMove: false,
  /**
   * @param {{ creds: object }} ctx
   * @param {{ glofoxMemberId: string, eventId: string }} req
   */
  async book({ creds }, { glofoxMemberId, eventId }) {
    const raw = await createBooking(creds, { user_id: glofoxMemberId, model: GLOFOX_BOOKING_MODEL, model_id: eventId })
    // Glofox can 200 with a failure body (YOU_HAVE_NO_CREDITS_LEFT): judged by
    // interpretBookingResult, never by HTTP ok alone.
    const { booked, bookingId, messageCode, alreadyBooked } = interpretBookingResult(raw)
    if (booked) return { verdict: 'done', id: bookingId, alreadyBooked: false, raw }
    // Glofox dedupes member+event: a re-run whose first attempt landed answers
    // "already booked", which is success.
    if (alreadyBooked) return { verdict: 'done', id: null, alreadyBooked: true, raw }
    return { verdict: 'refused', id: null, alreadyBooked: false, code: messageCode || `status_${raw?.status}`, retryable: false, raw }
  },
  /**
   * @param {{ creds: object }} ctx
   * @param {{ glofoxMemberId: string, bookingId: string }} req
   */
  async cancel({ creds }, { glofoxMemberId, bookingId }) {
    const raw = await cancelBooking(creds, bookingId, glofoxMemberId)
    // A late-cancel rule shows up only in the body, as success:false.
    if (raw?.ok && raw.body?.success !== false) return { verdict: 'done', id: bookingId, raw }
    return {
      verdict: 'refused',
      id: bookingId,
      code: raw?.body?.message_code || `status_${raw?.status}`,
      message: raw?.body?.message || raw?.body?.message_code || `Glofox cancel failed (HTTP ${raw?.status})`,
      retryable: false,
      raw,
    }
  },
})

// un1t.online's write primitives already answer in this shape (Un1tWriteResult),
// with their own ledger, write gate (WRITES_OFF) and retry codes.
const un1tOnlineOps = Object.freeze({
  platform: 'un1t_online',
  canMove: true,
  book: ({ db, deps }, req) => un1tBook(db, req, deps),
  cancel: ({ db, deps }, req) => un1tCancel(db, req, deps),
  move: ({ db, deps }, req) => un1tMove(db, req, deps),
})

const OPS = Object.freeze({ glofox: glofoxOps, un1t_online: un1tOnlineOps })

/** Platforms that can take a booking from the CRM. */
export const BOOKING_PLATFORMS = Object.freeze(Object.keys(OPS))

/**
 * @param {'glofox' | 'un1t_online'} platform  a studio's membership platform
 */
export function bookingOpsFor(platform) {
  const ops = OPS[platform]
  if (!ops) throw new Error(`bookingOpsFor: no booking platform '${platform}'`)
  return ops
}

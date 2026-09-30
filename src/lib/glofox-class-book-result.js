// GLOFOXWRITEJUDGE.1 (b) — what the staff Book panel shows after
// POST /api/glofox/classes/book, and whether it drops the confirmation line
// into the open chat. Pure; the panel (src/components/BookPanel.jsx) renders it.
//
// Already booked is a success (Glofox's member+event dedupe: the member is in
// the class) but NOT a new booking: no chat line (one may have gone when the
// first booking was made) and no Undo (no new booking id came back).
// Staff-facing copy only; the customer-facing chat line stays in BookPanel.

/**
 * @param {object|null} data  the route's JSON
 * @param {string} className
 * @returns {{ ok: boolean, message: string, sendChat: boolean, bookingId: string|null }}
 */
export function classBookResultView(data, className) {
  if (!data?.success) {
    return { ok: false, message: data?.error || 'Glofox booking failed', sendChat: false, bookingId: null }
  }
  if (data.already_booked) {
    return {
      ok: true,
      message: `Already booked into ${className} in Glofox. Nothing new was booked and no chat message was sent.`,
      sendChat: false,
      bookingId: null,
    }
  }
  return { ok: true, message: `Booked into ${className}.`, sendChat: true, bookingId: data.glofox_booking_id || null }
}

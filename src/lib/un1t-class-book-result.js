// UN1TWRITE.15 — what the staff Book panel says after a un1t.online class
// booking (POST /api/un1t-online/classes/book). Same shape as Glofox's
// classBookResultView: { ok, message, sendChat, bookingId }.
import { UN1T_STAFF_COPY } from './un1t-staff-booking-copy.js'

export function un1tClassBookResultView(data, className) {
  if (!data?.success) {
    return { ok: false, message: data?.error || UN1T_STAFF_COPY.unknown, sendChat: false, bookingId: null }
  }
  if (data.data?.already_booked) {
    return { ok: true, message: UN1T_STAFF_COPY.alreadyBooked, sendChat: false, bookingId: null }
  }
  return { ok: true, message: `Booked into ${className}.`, sendChat: true, bookingId: data.data?.un1t_booking_id || null }
}

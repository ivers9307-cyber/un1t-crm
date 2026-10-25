// BOOKINGSELF.1 — the person who booked cancels or reschedules their own
// booking from the link in their confirmation and reminder emails
// (/book/manage/[token], the token from booking-manage-tokens.js).
//
// The rules, in one place, for the four /api/public/booking-manage/[token]
// routes:
//   - only a `confirmed` booking can change;
//   - only until CHANGE_CUTOFF_MS (2 hours) before its start, judged on the
//     STUDIO's clock: booking_date/start_time are wall clock in the event
//     type's location zone, turned into an instant by zonedWallClockToInstant
//     (never `new Date(...Z)`);
//   - a reschedule also needs the booking type to be live (`active`), picks a
//     slot of the SAME type, and that slot is re-judged server-side by
//     findBookableSlot, the one check /api/public/book uses too;
//   - both writes are compare-and-swap on the row as it was read, so a staff
//     edit or a second tab in between is "changed, reload", never overwritten.
//
// After a reschedule: the booking's booking_reminder_sends rows and its
// legacy reminder_sent_at are cleared so every reminder fires again for the
// new time, a timeline line goes on the contact (staff are told about a
// public booking only through the timeline; a reschedule is told the same
// way), and the booking type's own confirmation is sent again (same
// channels and operator-written copy, with a fresh {{manage_url}}).
// A cancel only flips status: the booking_status_change_trigger writes the
// timeline line (mig 004), and nothing new is sent to the customer.
//
// Customer copy here is neutral UI wording only (no em dashes, no emoji):
// the booking pages carry no operator-editable copy, and the business
// message (the confirmation) stays the operator's template.

import { zonedWallClockToInstant } from '@/lib/location-time'
import { eventTypeZone, findBookableSlot, computeAvailableDays } from '@/lib/booking-slots'
import { fmtBookingTime, sendBookingConfirmation } from '@/lib/booking-confirmations'
import { logWarn, logError } from '@/lib/log'

export const CHANGE_CUTOFF_MS = 2 * 60 * 60 * 1000

// Everything the page and the two writes need, in one read.
export const MANAGED_BOOKING_SELECT = `
  id, status, contact_id, location_id, customer_name,
  booking_date, start_time, end_time, event_type_id,
  event_types (
    id, name, active, duration_minutes, buffer_minutes, availability, max_advance_days, location_id,
    locations:location_id ( id, name, address, timezone )
  )
`

/** HTTP status for each refusal code. */
export const BOOKING_MANAGE_STATUS = {
  not_found: 404,
  load_failed: 500,
  save_failed: 500,
  cancelled: 409,
  not_changeable: 409,
  reschedule_unavailable: 409,
  slot_unavailable: 409,
  changed: 409,
  same_time: 400,
}

/**
 * The customer sentence for a refusal code. Plain and short.
 * @param {string} code
 * @param {{ studioName?: string|null }} [ctx]
 */
export function bookingManageMessage(code, { studioName = null } = {}) {
  const studio = (studioName && String(studioName).trim()) || 'the studio'
  switch (code) {
    case 'not_found': return 'This link is not valid or has expired.'
    case 'cancelled': return 'This booking has been cancelled.'
    case 'not_changeable': return `This booking can no longer be changed online. Please contact ${studio}.`
    case 'reschedule_unavailable': return `This booking cannot be moved online. Please contact ${studio}.`
    case 'same_time': return 'You are already booked for that time.'
    case 'slot_unavailable': return 'That time is no longer available. Please pick another.'
    case 'changed': return 'This booking was just changed. Please reload the page.'
    case 'save_failed': return 'Your change could not be saved. Please try again.'
    default: return 'Something went wrong. Please try again.'
  }
}

/**
 * Read the booking a token names. `{ booking }` (null when there is no such
 * row) or `{ error }` for a failed read.
 */
export async function loadManagedBooking(db, bookingId) {
  const { data, error } = await db.from('bookings').select(MANAGED_BOOKING_SELECT).eq('id', bookingId).maybeSingle()
  if (error) return { booking: null, error }
  return { booking: data || null, error: null }
}

/** The start instant (UTC ms) of a booking in its studio zone, or null. */
export function bookingStartMs(booking, zone) {
  return zonedWallClockToInstant(booking?.booking_date, String(booking?.start_time || '').slice(0, 8), zone)
}

/**
 * What the holder may do right now. Pure.
 * @param {{ booking: object, zone: string, nowMs?: number }} args
 * @returns {{ canCancel: boolean, canReschedule: boolean, code: string|null }}
 *   `code` is the reason nothing (or only cancel) is allowed.
 */
export function bookingChangeState({ booking, zone, nowMs = Date.now() }) {
  if (!booking) return { canCancel: false, canReschedule: false, code: 'not_found' }
  if (booking.status === 'cancelled') return { canCancel: false, canReschedule: false, code: 'cancelled' }
  if (booking.status !== 'confirmed') return { canCancel: false, canReschedule: false, code: 'not_changeable' }
  const startMs = bookingStartMs(booking, zone)
  if (startMs == null) return { canCancel: false, canReschedule: false, code: 'not_changeable' }
  if (nowMs >= startMs - CHANGE_CUTOFF_MS) return { canCancel: false, canReschedule: false, code: 'not_changeable' }
  if (!booking.event_types || booking.event_types.active === false) {
    return { canCancel: true, canReschedule: false, code: 'reschedule_unavailable' }
  }
  return { canCancel: true, canReschedule: true, code: null }
}

/** The studio zone of a booking (its event type's location). Throws LocationZoneReadError. */
export function managedBookingZone(db, booking) {
  return eventTypeZone(db, booking?.event_types || { location_id: booking?.location_id || null })
}

/**
 * The public shape the manage page renders: no email, no phone, no ids
 * beyond the booking's own.
 */
export function publicBookingView(booking, state, { zone, availableDays = null } = {}) {
  const et = booking.event_types || {}
  const studioName = et.locations?.name || null
  return {
    id: booking.id,
    status: booking.status,
    customer_name: booking.customer_name || null,
    event_name: et.name || 'Booking',
    studio_name: studioName,
    studio_address: et.locations?.address || null,
    duration_minutes: et.duration_minutes ?? null,
    timezone: zone,
    booking_date: booking.booking_date,
    start_time: String(booking.start_time || '').slice(0, 5),
    end_time: String(booking.end_time || '').slice(0, 5),
    when_label: fmtBookingTime(booking.booking_date, booking.start_time),
    can_cancel: state.canCancel,
    can_reschedule: state.canReschedule,
    blocked_reason: !state.canCancel && state.code ? bookingManageMessage(state.code, { studioName }) : null,
    reschedule_note: state.code === 'reschedule_unavailable' ? bookingManageMessage(state.code, { studioName }) : null,
    available_days: availableDays,
  }
}

/** Days with a free slot for this booking's type, its own slot not counted as taken. */
export async function availableDaysForReschedule(db, booking, zone, { nowMs = Date.now() } = {}) {
  const et = booking.event_types
  const maxAdv = Number.isFinite(Number(et?.max_advance_days)) ? Number(et.max_advance_days) : 30
  return computeAvailableDays(db, et, { days: Math.min(31, Math.max(1, maxAdv + 1)), zone, nowMs, excludeBookingId: booking.id })
}

/**
 * Cancel. CAS on (id, status='confirmed'): zero rows touched = changed.
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function cancelBookingByCustomer(db, { booking }) {
  const { data, error } = await db.from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .select('id')
  if (error) {
    logError('booking-self-service', 'customer cancel write failed', { err: error, bookingId: booking.id })
    return { ok: false, code: 'save_failed' }
  }
  if (!Array.isArray(data) || data.length === 0) return { ok: false, code: 'changed' }
  return { ok: true }
}

/**
 * Reschedule to `date` + `startTime` on the same booking type.
 * The caller has already checked bookingChangeState().canReschedule.
 * @returns {Promise<{ ok: true, booking: { booking_date, start_time, end_time }, confirmation: object|null }
 *   | { ok: false, code: string }>}
 */
export async function rescheduleBookingByCustomer(db, { booking, date, startTime, zone, nowMs = Date.now() }) {
  const et = booking.event_types
  const oldStart = String(booking.start_time || '')
  if (date === booking.booking_date && String(startTime).slice(0, 5) === oldStart.slice(0, 5)) {
    return { ok: false, code: 'same_time' }
  }

  // The same rules as a new booking, with this booking's own slot free.
  let found
  try {
    found = await findBookableSlot(db, et, date, startTime, { zone, nowMs, excludeBookingId: booking.id })
  } catch (err) {
    logError('booking-self-service', 'reschedule slot check: zone unreadable', { err, bookingId: booking.id })
    return { ok: false, code: 'load_failed' }
  }
  if (found.error) {
    logError('booking-self-service', 'reschedule slot check: occupancy unreadable', { err: found.error, bookingId: booking.id })
    return { ok: false, code: 'load_failed' }
  }
  if (!found.slot) return { ok: false, code: 'slot_unavailable' }

  // CAS on the row exactly as read: still confirmed, still at the old time.
  const { data, error } = await db.from('bookings')
    .update({ booking_date: date, start_time: found.slot.start, end_time: found.slot.end, reminder_sent_at: null })
    .eq('id', booking.id)
    .eq('status', 'confirmed')
    .eq('booking_date', booking.booking_date)
    .eq('start_time', oldStart)
    .select('id')
  if (error) {
    logError('booking-self-service', 'customer reschedule write failed', { err: error, bookingId: booking.id })
    return { ok: false, code: 'save_failed' }
  }
  if (!Array.isArray(data) || data.length === 0) return { ok: false, code: 'changed' }

  // The move stands from here; everything below is best-effort and logged.

  // Reminders fire again for the new time. Cleared AFTER the move so a
  // refused move never wipes a booking's send history. A failure here means
  // the reminders already sent are not sent again: logged loud, never undone.
  try {
    const { error: delErr } = await db.from('booking_reminder_sends').delete().eq('booking_id', booking.id)
    if (delErr) logError('booking-self-service', 'reminder sends not cleared after reschedule; reminders already sent will not repeat', { err: delErr, bookingId: booking.id })
  } catch (err) {
    logError('booking-self-service', 'reminder sends clear threw after reschedule', { err, bookingId: booking.id })
  }

  const fromLabel = fmtBookingTime(booking.booking_date, booking.start_time)
  const toLabel = fmtBookingTime(date, found.slot.start)
  const timelineLocationId = booking.location_id || et?.location_id || null
  if (booking.contact_id && timelineLocationId) {
    try {
      const { error: actErr } = await db.from('activities').insert({
        contact_id: booking.contact_id,
        location_id: timelineLocationId,
        kind: 'event',
        type: 'booking',
        subject: `Booking rescheduled by customer: ${et?.name || 'Booking'}`,
        note: `Moved online from ${fromLabel} to ${toLabel}.`,
        due_date: date,
        due_time: found.slot.start,
        done: true,
      })
      if (actErr) logWarn('booking-self-service', 'reschedule timeline row failed', { err: actErr, bookingId: booking.id })
    } catch (err) {
      logWarn('booking-self-service', 'reschedule timeline row threw', { err, bookingId: booking.id })
    }
  }

  // The booking type's own confirmation, again: operator channels + copy.
  let confirmation = null
  try {
    confirmation = await sendBookingConfirmation(db, booking.id)
  } catch (err) {
    logWarn('booking-self-service', 'reschedule confirmation send threw; the move stands', { err, bookingId: booking.id })
  }

  return {
    ok: true,
    booking: { booking_date: date, start_time: found.slot.start, end_time: found.slot.end },
    confirmation,
  }
}

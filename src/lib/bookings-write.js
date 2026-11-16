// BOOKONE.1 (15 Nov feature audit, area 8) — the ONE way an event-type
// (consultation) booking is created. The public /book route, the staff Book
// panel (/api/bookings/create), the WhatsApp Flow completion and Mia's
// book_consultation tool all go through createBooking.
//
// Before it there were four inserts and only the public one checked the slot
// rules: staff could book outside hours, in the past or inside a blocked
// time, and a WhatsApp Flow booking was not re-checked at submit, so two
// people could hold one slot. Here every booking is judged by
// findBookableSlot (availability window, duration + buffer grid, max advance,
// not past on the studio's clock, not blocked, not overlapping), and the
// database itself refuses an overlap that slips between the check and the
// insert (mig 842, bookings_no_overlap: 23P01 -> code 'slot_taken').

import { findBookableSlot } from '@/lib/booking-slots'

/** The event_types columns findBookableSlot needs. */
export const BOOKING_EVENT_COLUMNS =
  'id, name, duration_minutes, buffer_minutes, availability, max_advance_days, location_id, active, locations:location_id ( timezone )'

/** Postgres exclusion_violation: the slot was taken between check and insert. */
const EXCLUSION_VIOLATION = '23P01'

/**
 * @param {object} db service-role client
 * @param {{
 *   event: object,             // an event_types row with BOOKING_EVENT_COLUMNS
 *   date: string,              // YYYY-MM-DD, the studio's calendar
 *   startTime: string,         // HH:MM on the studio's clock
 *   customer: { name: string, email: string, phone?: string|null },
 *   customResponses?: object,
 *   source?: string,
 *   contactId?: string|null, // set when the contact is already known (the Flow)
 *   slot?: { start: string, end: string } | null, // a slot the caller already found (Mia's tool)
 * }} args
 * @returns {Promise<
 *   | { ok: true, booking: object, slot: { start: string, end: string } }
 *   | { ok: false, code: 'slot_unavailable' | 'slot_taken' | 'slot_check_failed' | 'insert_failed', error?: any }
 * >}
 */
export async function createBooking(db, { event, date, startTime, customer, customResponses = {}, source, contactId = null, slot: knownSlot = null }) {
  let slot = knownSlot
  if (!slot) {
    let found
    try {
      found = await findBookableSlot(db, event, date, startTime)
    } catch (error) {
      return { ok: false, code: 'slot_check_failed', error }
    }
    if (found.error) return { ok: false, code: 'slot_check_failed', error: found.error }
    if (!found.slot) return { ok: false, code: 'slot_unavailable' }
    slot = found.slot
  }

  const { data, error } = await db.from('bookings').insert({
    event_type_id: event.id,
    // BOOKING.1 — the event's studio is copied onto the booking.
    location_id: event.location_id || null,
    booking_date: date,
    start_time: slot.start,
    end_time: slot.end,
    customer_name: customer.name,
    customer_email: String(customer.email || '').toLowerCase().trim(),
    customer_phone: customer.phone || null,
    custom_responses: customResponses || {},
    source: source || 'unknown',
    status: 'confirmed',
    ...(contactId ? { contact_id: contactId } : {}),
  }).select().single()
  if (error) {
    if (error.code === EXCLUSION_VIOLATION) return { ok: false, code: 'slot_taken', error }
    return { ok: false, code: 'insert_failed', error }
  }
  return { ok: true, booking: data, slot }
}

/** Read an event type with the columns createBooking needs. */
export async function loadBookingEvent(db, eventTypeId) {
  const { data, error } = await db.from('event_types').select(BOOKING_EVENT_COLUMNS).eq('id', eventTypeId).maybeSingle()
  return { event: data || null, error: error || null }
}

/**
 * The WhatsApp Flow's consult booking: the slot picked in the Flow is judged
 * again at submit (it may have gone since the Flow showed it).
 * @returns {Promise<{ bookingId: string } | { error: { message: string, code?: string } }>}
 */
export async function createEventBooking(db, { event, date, startTime, contact, source }) {
  const loaded = await loadBookingEvent(db, event.id)
  if (loaded.error) return { error: { message: loaded.error.message || 'event read failed', code: 'slot_check_failed' } }
  if (!loaded.event || loaded.event.active === false) return { error: { message: 'event type not found', code: 'not_found' } }
  if (event.location_id && loaded.event.location_id !== event.location_id) {
    return { error: { message: 'event type belongs to another studio', code: 'not_found' } }
  }
  const res = await createBooking(db, {
    event: loaded.event, date, startTime,
    customer: { name: contact.name, email: contact.email, phone: contact.phone },
    contactId: contact.id || null,
    source,
  })
  if (!res.ok) return { error: { message: res.error?.message || res.code, code: res.code } }
  return { bookingId: res.booking.id }
}

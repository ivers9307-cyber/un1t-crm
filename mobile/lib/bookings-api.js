// NOTIF.2 — mobile data helpers for the Bookings tab.
//
// Operator view: today + tomorrow's confirmed bookings at the active
// location. Read-only from mobile (creation, cancellation, reschedule
// all stay on the web Calendly hub). Pulls directly via supabase
// using the existing RLS on `bookings` (mig 014 — location-scoped).

import { supabase } from './supabase'

const BOOKING_SELECT = `
  id, customer_name, customer_email, customer_phone,
  booking_date, start_time, end_time, status, skip_reminder,
  notes, location_id,
  event_type:event_types(id, name, duration_minutes, color),
  contact:contacts(id, first_name, last_name)
`

/**
 * Today + tomorrow's bookings at a location.
 *
 * The day boundary is treated as the LOCATION's local day, but we
 * filter on booking_date (a plain DATE column). Since operators only
 * ever care about "their" studio's day, the location-local date is
 * computed client-side from the supplied isoDate (or `today` derived
 * from the device clock — the staff device is at the location, so
 * device clock = location clock for the operator's working hours).
 */
export async function listUpcomingBookings({ locationId, today, daysAhead = 1 }) {
  if (!locationId) return { success: false, error: 'locationId required' }

  const start = today || new Date().toISOString().slice(0, 10)
  const end = addDaysIso(start, daysAhead)

  const { data, error } = await supabase.from('bookings')
    .select(BOOKING_SELECT)
    .eq('location_id', locationId)
    .eq('status', 'confirmed')
    .gte('booking_date', start)
    .lte('booking_date', end)
    .order('booking_date', { ascending: true })
    .order('start_time', { ascending: true })

  if (error) return { success: false, error: error.message }
  return { success: true, data: data || [] }
}

/**
 * Single booking by id. Push-notification deep links land here.
 */
export async function getBooking(id) {
  if (!id) return { success: false, error: 'id required' }
  const { data, error } = await supabase.from('bookings')
    .select(BOOKING_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: 'Booking not found' }
  return { success: true, data }
}

// ─── helpers ───

function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

export function groupByDate(rows) {
  const out = {}
  for (const r of rows) {
    if (!out[r.booking_date]) out[r.booking_date] = []
    out[r.booking_date].push(r)
  }
  return out
}

export function formatBookingTime(timeStr) {
  if (!timeStr) return ''
  const [hh, mm] = String(timeStr).split(':')
  const h = Number(hh) % 12 || 12
  const ampm = Number(hh) < 12 ? 'am' : 'pm'
  return `${h}:${mm}${ampm}`
}

// AGENT-HANDS.1 — consultation slot machinery, extracted from
// /api/public/bookings/[slug]/slots so the customer agent's
// consultation tools reuse the EXACT availability logic the public
// booking widget uses (incident-hardened local-time semantics —
// see the route's TIMEZONE NOTES from the 2026-05-11 incident).
//
// Pure: generateDaySlots + filterAvailableSlots (unit-tested).
// IO: computeAvailableSlots(db, event, date) — queries bookings +
// blocked_times and applies the same range/day/past filters the
// route applied inline before this extraction.
//
// TZ.7: availability windows and bookings.booking_date/start_time are wall
// clock in the STUDIO's zone (the event type's location), so "today" and
// "already past" are judged on that zone's clock, never Dublin's or the
// server's. Europe/Dublin output is byte-identical to before
// (bookings-classes.tz.test.js).

import { todayStrIn, nowMinutesIn, addDaysISO, zoneOfLocation, getLocationZone, DEFAULT_TZ } from '@/lib/location-time'
import { dayWindows } from '@/lib/booking-windows'

/**
 * Generate the day's candidate slots from an availability window.
 * Steps by duration+buffer; never emits a slot overrunning the end.
 * Pure. `win` = { start: 'HH:MM', end: 'HH:MM' }.
 */
export function generateDaySlots(win, opts = {}) {
  if (!win || !win.start || !win.end) return []
  const durationMinutes = Number(opts.durationMinutes ?? win.durationMinutes) || 0
  const bufferMinutes = Number(opts.bufferMinutes ?? win.bufferMinutes) || 0
  if (durationMinutes <= 0) return []

  const [startH, startM] = win.start.split(':').map(Number)
  const [endH, endM] = win.end.split(':').map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM
  const step = durationMinutes + bufferMinutes

  const slots = []
  for (let m = startMinutes; m + durationMinutes <= endMinutes; m += step) {
    const slotStart = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    const slotEndM = m + durationMinutes
    const slotEnd = `${String(Math.floor(slotEndM / 60)).padStart(2, '0')}:${String(slotEndM % 60).padStart(2, '0')}`
    slots.push({ start: slotStart, end: slotEnd })
  }
  return slots
}

/**
 * Subtract booked/blocked overlaps and (when nowMinutes >= 0) slots
 * already past on the studio's clock. Pure — overlap predicate is the
 * route's original `slot.start < b.end && slot.end > b.start`.
 */
export function filterAvailableSlots(slots, { booked = [], blocked = [], nowMinutes = -1 } = {}) {
  return (slots || []).filter((slot) => {
    const isBooked = booked.some((b) => slot.start < b.end && slot.end > b.start)
    if (isBooked) return false
    const isBlocked = blocked.some((b) => slot.start < b.end && slot.end > b.start)
    if (isBlocked) return false
    if (nowMinutes >= 0) {
      const [slotH, slotM] = slot.start.split(':').map(Number)
      if (slotH * 60 + slotM <= nowMinutes) return false
    }
    return true
  })
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/**
 * The zone an event type's slots are written in: its location's. Uses the
 * `locations` embed when the caller's select carried one (no IO), else the
 * location row (cached 60 s). No location → DEFAULT_TZ.
 * @throws {import('@/lib/location-time').LocationZoneReadError} the zone read
 *   failed: deciding what is bookable on a guessed clock is not safe, so the
 *   caller fails as it would on any DB outage.
 */
export async function eventTypeZone(db, event) {
  if (event?.locations && typeof event.locations === 'object') return zoneOfLocation(event.locations)
  if (event?.location_id) return getLocationZone(db, event.location_id)
  return DEFAULT_TZ
}

/**
 * The booked and blocked windows on a date for an event type, as
 * { start: 'HH:MM', end: 'HH:MM' } lists. `excludeBookingId` leaves one
 * booking out (BOOKINGSELF.1: a reschedule must not collide with the very
 * booking it is moving). `error` is the first failed read, or null.
 */
async function readDayOccupancy(db, eventTypeId, date, excludeBookingId = null) {
  let bookingsQ = db.from('bookings')
    .select('start_time, end_time')
    .eq('event_type_id', eventTypeId)
    .eq('booking_date', date)
    .in('status', ['confirmed', 'completed'])
  if (excludeBookingId) bookingsQ = bookingsQ.neq('id', excludeBookingId)
  const [bookingsRes, blockedRes] = await Promise.all([
    bookingsQ,
    db.from('blocked_times')
      .select('start_time, end_time')
      .eq('event_type_id', eventTypeId)
      .eq('blocked_date', date),
  ])
  const booked = (bookingsRes?.data || []).map((b) => ({
    start: b.start_time.slice(0, 5),
    end: b.end_time.slice(0, 5),
  }))
  const blocked = (blockedRes?.data || []).map((b) => ({
    start: b.start_time ? b.start_time.slice(0, 5) : '00:00',
    end: b.end_time ? b.end_time.slice(0, 5) : '23:59',
  }))
  return { booked, blocked, error: bookingsRes?.error || blockedRes?.error || null }
}

/**
 * The day's full slot grid for an event type, before any booking, block or
 * past-time filter: every slot the availability windows generate on that
 * weekday. MIACONSULT.1 uses it to tell "that slot was offered but has been
 * taken since" from "that time was never a slot at all". Pure.
 * @param {object} event  { availability, duration_minutes, buffer_minutes }
 * @param {string} date   'YYYY-MM-DD' (studio wall clock)
 * @returns {Array<{ start: string, end: string }>}
 */
export function daySlotGrid(event, date) {
  if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return []
  const dayName = DAY_NAMES[new Date(date + 'T00:00:00Z').getUTCDay()]
  // BOOKINGWINDOWS.1: a day may hold several windows; each starts its own
  // duration+buffer grid, and nothing is offered in the gaps between them.
  const windows = dayWindows(event.availability, dayName)
  return windows.flatMap((win) => generateDaySlots(win, {
    durationMinutes: event.duration_minutes,
    bufferMinutes: event.buffer_minutes,
  }))
}

// Everything computeAvailableSlots decides, plus the occupancy read's error.
async function availableSlotsWithError(db, event, date, { zone, nowMs = Date.now(), excludeBookingId = null } = {}) {
  if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { slots: [], error: null }

  const tz = zone || await eventTypeZone(db, event)
  const todayStr = todayStrIn(tz, nowMs)
  const maxDateStr = addDaysISO(todayStr, event.max_advance_days)
  if (date < todayStr || date > maxDateStr) return { slots: [], error: null }

  const slots = daySlotGrid(event, date)
  if (!slots.length) return { slots: [], error: null }

  const { booked, blocked, error } = await readDayOccupancy(db, event.id, date, excludeBookingId)
  const nowMinutes = date === todayStr ? nowMinutesIn(tz, nowMs) : -1
  return { slots: filterAvailableSlots(slots, { booked, blocked, nowMinutes }), error }
}

/**
 * Available slots for an event_types row on a calendar date.
 * Mirrors the public slots route end-to-end: studio-time range checks
 * (today / max_advance_days), weekday availability lookup (UTC-stable),
 * slot generation per window, booked + blocked subtraction, today's past-time
 * filter. Returns [] outside the bookable range. `event` must carry
 * { id, duration_minutes, buffer_minutes, availability, max_advance_days }
 * and, for its zone, `location_id` (or a `locations: { timezone }` embed).
 * Display path: a failed bookings/blocked read is treated as "none" (the
 * write path, findBookableSlot, fails closed instead).
 * @param {{ zone?: string, nowMs?: number, excludeBookingId?: string|null }} [opts]
 *   zone: the studio's, when the caller already holds it; nowMs: the clock
 *   (tests); excludeBookingId: leave this booking out of "taken" (reschedule).
 */
export async function computeAvailableSlots(db, event, date, opts = {}) {
  const { slots } = await availableSlotsWithError(db, event, date, opts)
  return slots
}

/**
 * BOOKINGSELF.1 — the ONE server-side check that a requested slot may be
 * booked: it is one of computeAvailableSlots' slots for that date, so the
 * availability window, the duration + buffer grid, max_advance_days, the
 * studio's today, blocked times and every other confirmed/completed booking
 * are all judged exactly as the public widget offered them. Used by
 * /api/public/book (create) and the customer reschedule.
 *
 * Unlike the display path it FAILS CLOSED: an unreadable bookings or blocked
 * read is `{ error }`, never "free".
 *
 * @param {object} db
 * @param {object} event  as computeAvailableSlots
 * @param {string} date   'YYYY-MM-DD' (studio wall clock)
 * @param {string} startTime 'HH:MM' or 'HH:MM:SS'
 * @param {{ zone?: string, nowMs?: number, excludeBookingId?: string|null }} [opts]
 * @returns {Promise<{ slot: { start: string, end: string }|null, error: object|null }>}
 * @throws {import('@/lib/location-time').LocationZoneReadError} the zone read failed
 */
export async function findBookableSlot(db, event, date, startTime, opts = {}) {
  const want = String(startTime || '').slice(0, 5)
  if (!/^\d{2}:\d{2}$/.test(want)) return { slot: null, error: null }
  const { slots, error } = await availableSlotsWithError(db, event, date, opts)
  if (error) return { slot: null, error }
  return { slot: slots.find((s) => s.start === want) || null, error: null }
}

// A calendar DATE's label: noon UTC on that date is the same calendar day
// read in UTC, so the label needs no zone at all (TZ.7: was Europe/Dublin,
// which gave the same text for every date).
const dayLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Which of the next `days` calendar days actually have ≥1 available slot.
 * Reuses computeAvailableSlots per day (in parallel) so the day list can NEVER
 * diverge from the per-day slot list — same incident-hardened studio-time
 * semantics, no reimplementation. Clamped to the event's max_advance_days.
 * Returns [{ date: 'YYYY-MM-DD', label: 'Tue, 30 Jun' }] for bookable days only.
 */
export async function computeAvailableDays(db, event, { days = 14, zone, nowMs = Date.now(), excludeBookingId = null } = {}) {
  if (!event) return []
  const tz = zone || await eventTypeZone(db, event)
  const todayStr = todayStrIn(tz, nowMs)
  const horizon = Math.min(Math.max(1, Number(days) || 14), 31)
  const maxAdv = Number.isFinite(Number(event.max_advance_days)) && Number(event.max_advance_days) >= 0
    ? Number(event.max_advance_days) : 30
  const maxDateStr = addDaysISO(todayStr, maxAdv)
  const dates = []
  for (let i = 0; i < horizon; i++) {
    const d = addDaysISO(todayStr, i)
    if (d > maxDateStr) break
    dates.push(d)
  }
  const checked = await Promise.all(dates.map(async (date) => {
    const slots = await computeAvailableSlots(db, event, date, { zone: tz, nowMs, excludeBookingId })
    return slots.length > 0 ? date : null
  }))
  return checked
    .filter(Boolean)
    .map((date) => ({ date, label: dayLabelFmt.format(new Date(`${date}T12:00:00Z`)) }))
}

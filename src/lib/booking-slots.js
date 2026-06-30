// AGENT-HANDS.1 — consultation slot machinery, extracted from
// /api/public/bookings/[slug]/slots so the customer agent's
// consultation tools reuse the EXACT availability logic the public
// booking widget uses (incident-hardened Dublin-time semantics —
// see the route's TIMEZONE NOTES from the 2026-05-11 incident).
//
// Pure: generateDaySlots + filterAvailableSlots (unit-tested).
// IO: computeAvailableSlots(db, event, date) — queries bookings +
// blocked_times and applies the same range/day/past filters the
// route applied inline before this extraction.

import { dublinTodayStr, dublinNowMinutes, addDaysISO } from '@/lib/dublin-time'

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
 * already past on the Dublin clock. Pure — overlap predicate is the
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
 * Available slots for an event_types row on a calendar date.
 * Mirrors the public slots route end-to-end: Dublin-time range checks
 * (today / max_advance_days), weekday availability lookup (UTC-stable),
 * slot generation, booked + blocked subtraction, today's past-time
 * filter. Returns [] outside the bookable range. `event` must carry
 * { id, duration_minutes, buffer_minutes, availability, max_advance_days }.
 */
export async function computeAvailableSlots(db, event, date) {
  if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return []

  const todayStr = dublinTodayStr()
  const maxDateStr = addDaysISO(todayStr, event.max_advance_days)
  if (date < todayStr || date > maxDateStr) return []

  const dayName = DAY_NAMES[new Date(date + 'T00:00:00Z').getUTCDay()]
  const dayAvailability = event.availability?.[dayName]
  if (!dayAvailability) return []

  const slots = generateDaySlots(dayAvailability, {
    durationMinutes: event.duration_minutes,
    bufferMinutes: event.buffer_minutes,
  })

  const [{ data: existingBookings }, { data: blockedTimes }] = await Promise.all([
    db.from('bookings')
      .select('start_time, end_time')
      .eq('event_type_id', event.id)
      .eq('booking_date', date)
      .in('status', ['confirmed', 'completed']),
    db.from('blocked_times')
      .select('start_time, end_time')
      .eq('event_type_id', event.id)
      .eq('blocked_date', date),
  ])

  const booked = (existingBookings || []).map((b) => ({
    start: b.start_time.slice(0, 5),
    end: b.end_time.slice(0, 5),
  }))
  const blocked = (blockedTimes || []).map((b) => ({
    start: b.start_time ? b.start_time.slice(0, 5) : '00:00',
    end: b.end_time ? b.end_time.slice(0, 5) : '23:59',
  }))

  const nowMinutes = date === todayStr ? dublinNowMinutes() : -1
  return filterAvailableSlots(slots, { booked, blocked, nowMinutes })
}

const dayLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Which of the next `days` calendar days actually have ≥1 available slot.
 * Reuses computeAvailableSlots per day (in parallel) so the day list can NEVER
 * diverge from the per-day slot list — same incident-hardened Dublin-time
 * semantics, no reimplementation. Clamped to the event's max_advance_days.
 * Returns [{ date: 'YYYY-MM-DD', label: 'Tue, 30 Jun' }] for bookable days only.
 */
export async function computeAvailableDays(db, event, { days = 14 } = {}) {
  if (!event) return []
  const todayStr = dublinTodayStr()
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
    const slots = await computeAvailableSlots(db, event, date)
    return slots.length > 0 ? date : null
  }))
  return checked
    .filter(Boolean)
    .map((date) => ({ date, label: dayLabelFmt.format(new Date(`${date}T12:00:00Z`)) }))
}

// TZ.7 — FROZEN copies of the bookings/classes functions as they were before
// the sweep made them take the studio's zone. Test-only: the byte-identity
// tests in bookings-classes.tz.test.js diff the new code (zone =
// 'Europe/Dublin') against these. Do not edit; TZ.18b deletes this file.
import { dublinTodayStr, dublinNowMinutes, addDaysISO, dublinDateKey, dublinDayStartMs, dublinAddDays } from '@/lib/dublin-time'
import { generateDaySlots, filterAvailableSlots } from '@/lib/booking-slots'

// ── src/lib/booking-slots.js ───────────────────────────────────────────────
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export async function computeAvailableSlotsLegacyDublin(db, event, date) {
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

const slotsDayLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })

export async function computeAvailableDaysLegacyDublin(db, event, { days = 14 } = {}) {
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
    const slots = await computeAvailableSlotsLegacyDublin(db, event, date)
    return slots.length > 0 ? date : null
  }))
  return checked
    .filter(Boolean)
    .map((date) => ({ date, label: slotsDayLabelFmt.format(new Date(`${date}T12:00:00Z`)) }))
}

// ── src/lib/booking-confirmations.js ───────────────────────────────────────
export function fmtBookingTimeLegacyDublin(dateStr, timeStr) {
  if (!dateStr) return ''
  const timePart = String(timeStr || '').slice(0, 5)
  try {
    const dayLabel = new Intl.DateTimeFormat('en-IE', {
      timeZone: 'Europe/Dublin',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${dateStr}T12:00:00Z`))
    return timePart ? `${dayLabel}, ${timePart}` : dayLabel
  } catch {
    return `${dateStr} ${timePart}`
  }
}

// ── src/lib/bridge-samples.js ──────────────────────────────────────────────
export function dublinWallClockToMsLegacyDublin(dateStr, timeStr) {
  const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const tm = String(timeStr || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!dm || !tm) return NaN
  const y = +dm[1], mo = +dm[2], d = +dm[3]
  const h = +tm[1], mi = +tm[2], s = +(tm[3] || 0)
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const p = {}
  for (const part of dtf.formatToParts(new Date(asUtc))) p[part.type] = part.value
  const tzAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  const offset = tzAsUtc - asUtc
  return asUtc - offset
}

// ── src/lib/class-booking-processor.js ─────────────────────────────────────
const processorLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
export function classLabelLegacyDublin(startsAt) {
  if (!startsAt) return 'your class'
  const d = new Date(startsAt)
  return isNaN(d.getTime()) ? 'your class' : processorLabelFmt.format(d)
}

// ── src/lib/manual-booking-confirm-copy.js ─────────────────────────────────
const confirmLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
export function formatClassTimeLegacyDublin(startsAt) {
  const d = startsAt ? new Date(startsAt) : null
  if (!d || isNaN(d.getTime())) return ''
  const parts = confirmLabelFmt.formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t)?.value || ''
  return `${get('weekday')} ${get('day')} ${get('month')} at ${get('hour')}:${get('minute')}`
}

// ── src/lib/public-classes.js ──────────────────────────────────────────────
const pcDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' })
const pcTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false })
const pcLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
export function shapePublicClassLegacyDublin(e) {
  const startSec = Number(e.time_start) || 0
  const ms = startSec * 1000
  const d = new Date(ms)
  return {
    event_id: e._id || e.id,
    name: e.name || 'Class',
    starts_at: new Date(ms).toISOString(),
    day: pcDayFmt.format(d),
    day_label: pcLabelFmt.format(d),
    time: pcTimeFmt.format(d),
  }
}

// ── src/lib/manual-timetable.js ────────────────────────────────────────────
const MANUAL_EVENT_PREFIX = 'manual-'
const mtLabelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
const mtWallFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false })
function isoWeekday(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  return js === 0 ? 7 : js
}
function dublinWallClockMs(dateKey, time) {
  const [h, mi] = time.split(':').map(Number)
  const wanted = h * 60 + mi
  const guess = dublinDayStartMs(dateKey) + wanted * 60_000
  const parts = mtWallFmt.formatToParts(new Date(guess))
  const gh = Number(parts.find((p) => p.type === 'hour')?.value) % 24
  const gm = Number(parts.find((p) => p.type === 'minute')?.value)
  return guess + (wanted - (gh * 60 + gm)) * 60_000
}
function slugForId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'class'
}
export function manualClassOccurrencesLegacyDublin({ slots, startDate = null, minNoticeHours = 12, days = 7, now = Date.now() }) {
  if (!Array.isArray(slots) || !slots.length) return []
  const today = dublinDateKey(now)
  const first = startDate && startDate > today ? startDate : today
  const earliestMs = now + Math.max(0, Number(minNoticeHours) || 0) * 3_600_000
  const span = Math.min(14, Math.max(1, Number(days) || 7))
  const out = []
  for (let n = 0; n < span; n += 1) {
    const dateKey = dublinAddDays(first, n)
    const dow = isoWeekday(dateKey)
    for (const slot of slots) {
      if (slot.dow !== dow) continue
      const ms = dublinWallClockMs(dateKey, slot.time)
      if (ms < earliestMs) continue
      out.push({
        event_id: `${MANUAL_EVENT_PREFIX}${dateKey.replaceAll('-', '')}-${slot.time.replace(':', '')}-${slugForId(slot.name)}`,
        name: slot.name,
        starts_at: new Date(ms).toISOString(),
        day: dateKey,
        day_label: mtLabelFmt.format(new Date(ms)),
        time: slot.time,
      })
    }
  }
  out.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.name.localeCompare(b.name))
  return out
}

// ── the bookings pages + BookingSkipReminderToggle ─────────────────────────
// Each split "upcoming vs past" on `booking_date >= dublinTodayStr()`.
export const bookingsTodayLegacyDublin = () => dublinTodayStr()

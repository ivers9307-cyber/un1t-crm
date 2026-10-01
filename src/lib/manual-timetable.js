// MANUALFUNNEL.1 — an operator-written weekly timetable for a studio with no
// Glofox (Hatch Street books on its own platform, which the CRM cannot read
// or write). The class_funnel block carries the timetable as plain text, one
// line per class time, and this module turns it into the SAME public class
// shape the Glofox list produces (PUBLIC_CLASS_KEYS in public-classes.js), so
// the funnel, the booking route and the staff card need no second code path
// to show it. Nothing is booked from here: a request for one of these
// classes always goes to staff (class-booking-processor.js).
//
// Pure: no DB, no network, `now` is a parameter.
import { dublinDateKey, dublinDayStartMs, dublinAddDays } from '@/lib/dublin-time'

const DUBLIN = 'Europe/Dublin'
const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: DUBLIN, weekday: 'short', day: 'numeric', month: 'short' })
const wallFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DUBLIN, hour: '2-digit', minute: '2-digit', hour12: false })

// Every id this module mints starts with this, and nothing Glofox mints does
// (its ids are 24 hex characters). The processor, the approve route and the
// card copy all judge "booked by hand" on it, never on a card's `reason`,
// which a retry path can rewrite.
export const MANUAL_EVENT_PREFIX = 'manual-'
export function isManualEventId(id) {
  return typeof id === 'string' && id.startsWith(MANUAL_EVENT_PREFIX)
}

export const DEFAULT_MIN_NOTICE_HOURS = 12
const MAX_MIN_NOTICE_HOURS = 168
const MAX_SLOTS = 200
const MAX_NAME = 80
const DEFAULT_CLASS_NAME = 'Class'

const DAY_INDEX = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
}
const DAY_GROUPS = {
  daily: [1, 2, 3, 4, 5, 6, 7],
  everyday: [1, 2, 3, 4, 5, 6, 7],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [6, 7],
}
const RANGE_WORDS = new Set(['-', '–', 'to'])

function dayRange(a, b) {
  const out = []
  // Wraps past Sunday, so "Sat-Mon" is Sat, Sun, Mon.
  for (let d = a; ; d = (d % 7) + 1) {
    out.push(d)
    if (d === b) break
  }
  return out
}

// "mon", "Mon,", "mon-fri", "mon/wed/fri", "weekdays" → day numbers (1 = Mon).
// null when any part of the token is not a day.
function parseDayToken(raw) {
  const t = String(raw || '').toLowerCase().replace(/[,;:]+$/, '')
  if (!t) return null
  if (DAY_GROUPS[t]) return DAY_GROUPS[t]
  const out = []
  for (const part of t.split(/[,/&+]/).filter(Boolean)) {
    const ends = part.split(/[-–]/)
    if (ends.length === 2 && DAY_INDEX[ends[0]] && DAY_INDEX[ends[1]]) {
      out.push(...dayRange(DAY_INDEX[ends[0]], DAY_INDEX[ends[1]]))
    } else if (ends.length === 1 && DAY_INDEX[part]) {
      out.push(DAY_INDEX[part])
    } else {
      return null
    }
  }
  return out.length ? out : null
}

// "06:15", "6.15", "0615", "6am", "6:15pm" → 'HH:MM'. A bare number ("6") is
// not a time: it is as likely the start of a class name.
function parseTimeToken(raw, meridiem = null) {
  const t = String(raw || '').toLowerCase().replace(/[,;]+$/, '')
  let h, mi, mer
  let m = t.match(/^(\d{1,2})[:.h](\d{2})(am|pm)?$/)
  if (m) {
    h = Number(m[1]); mi = Number(m[2]); mer = m[3] || meridiem
  } else if ((m = t.match(/^(\d{2})(\d{2})$/))) {
    h = Number(m[1]); mi = Number(m[2]); mer = meridiem
  } else if ((m = t.match(/^(\d{1,2})(am|pm)$/))) {
    h = Number(m[1]); mi = 0; mer = m[2]
  } else if (meridiem && (m = t.match(/^(\d{1,2})$/))) {
    h = Number(m[1]); mi = 0; mer = meridiem
  } else {
    return null
  }
  if (mer) {
    if (h < 1 || h > 12) return null
    if (mer === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  }
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/**
 * Parse the operator's timetable text. One class time per line:
 *   Mon 06:15 Strength
 *   Mon-Fri 07:15, 12:15, 18:00 Conditioning
 *   Sat 9am
 * Blank lines and lines starting with # are skipped. A line it cannot read
 * is returned in `rejected` (for the editor's preview), never guessed at.
 * @returns {{ slots: {dow:number,time:string,name:string}[], rejected: string[] }}
 */
export function parseManualTimetable(text) {
  const slots = []
  const rejected = []
  const seen = new Set()
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const tokens = line.split(/\s+/)
    let i = 0

    const days = []
    while (i < tokens.length) {
      const lower = tokens[i].toLowerCase()
      // "Mon - Fri" / "Mon to Fri": a range written with spaces.
      if (RANGE_WORDS.has(lower) && days.length && i + 1 < tokens.length) {
        const next = parseDayToken(tokens[i + 1])
        if (next && next.length === 1) {
          const from = days.pop()
          days.push(...dayRange(from, next[0]))
          i += 2
          continue
        }
        break
      }
      const parsed = parseDayToken(tokens[i])
      if (!parsed) break
      days.push(...parsed)
      i += 1
    }

    const times = []
    while (i < tokens.length) {
      // "6:15 am": the meridiem as its own token.
      const nextLower = (tokens[i + 1] || '').toLowerCase().replace(/[,;]+$/, '')
      const spacedMeridiem = nextLower === 'am' || nextLower === 'pm' ? nextLower : null
      let time = parseTimeToken(tokens[i], spacedMeridiem)
      let usedMeridiem = !!spacedMeridiem
      // "18:00 PM Burn": the next word is a class name, not a meridiem.
      if (!time && spacedMeridiem) { time = parseTimeToken(tokens[i], null); usedMeridiem = false }
      if (!time) break
      times.push(time)
      i += usedMeridiem ? 2 : 1
    }

    if (!days.length || !times.length) {
      rejected.push(line.slice(0, 120))
      continue
    }
    const name = tokens.slice(i).join(' ').replace(/^[-–·:|\s]+/, '').trim().slice(0, MAX_NAME) || DEFAULT_CLASS_NAME
    for (const dow of days) {
      for (const time of times) {
        const key = `${dow}|${time}|${name.toLowerCase()}`
        if (seen.has(key) || slots.length >= MAX_SLOTS) continue
        seen.add(key)
        slots.push({ dow, time, name })
      }
    }
  }
  slots.sort((a, b) => a.dow - b.dow || a.time.localeCompare(b.time) || a.name.localeCompare(b.name))
  return { slots, rejected }
}

// 1 = Monday … 7 = Sunday for a 'YYYY-MM-DD' calendar day. Pure calendar
// arithmetic: a calendar day's weekday does not depend on a timezone.
function isoWeekday(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

// UTC ms of a Europe/Dublin wall-clock time on a Dublin calendar day.
// Midnight + minutes is an hour out on the two clock-change days (25 Oct 2026
// has 25 hours), so read back the wall clock it landed on and correct once.
function dublinWallClockMs(dateKey, time) {
  const [h, mi] = time.split(':').map(Number)
  const wanted = h * 60 + mi
  const guess = dublinDayStartMs(dateKey) + wanted * 60_000
  const parts = wallFmt.formatToParts(new Date(guess))
  const gh = Number(parts.find((p) => p.type === 'hour')?.value) % 24
  const gm = Number(parts.find((p) => p.type === 'minute')?.value)
  return guess + (wanted - (gh * 60 + gm)) * 60_000
}

function slugForId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'class'
}

/**
 * The timetable's classes for the next `days` Dublin calendar days, in the
 * public class shape. The window starts today, or on `startDate` when that is
 * later (a studio that has not opened yet shows its first week, not an empty
 * list). A class starting inside the notice window is left out: staff book
 * these by hand and need the time to do it.
 */
export function manualClassOccurrences({ slots, startDate = null, minNoticeHours = DEFAULT_MIN_NOTICE_HOURS, days = 7, now = Date.now() }) {
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
        day_label: labelFmt.format(new Date(ms)),
        time: slot.time,
      })
    }
  }
  out.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.name.localeCompare(b.name))
  return out
}

/**
 * The manual timetable settings on a landing row's class_funnel block, or
 * null when the block has no timetable text (the studio's funnel is not a
 * manual one). Reads the same block classFunnelConfigFromBlocks does.
 */
export function manualTimetableConfigFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  const cf = list.find((b) => b && typeof b === 'object' && b.type === 'class_funnel')
  const text = typeof cf?.timetable === 'string' ? cf.timetable : ''
  if (!text.trim()) return null
  const start = typeof cf.timetable_start_date === 'string' ? cf.timetable_start_date.trim() : ''
  const rawNotice = cf.min_notice_hours
  const notice = rawNotice === '' || rawNotice == null ? NaN : Number(rawNotice)
  return {
    text,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : null,
    minNoticeHours: Number.isFinite(notice) && notice >= 0
      ? Math.min(MAX_MIN_NOTICE_HOURS, notice)
      : DEFAULT_MIN_NOTICE_HOURS,
  }
}

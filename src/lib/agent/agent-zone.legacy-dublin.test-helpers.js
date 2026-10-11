// TZ.5 — frozen pre-change copies of every function TZ.5 made zone-aware, kept
// ONLY so agent-zone.tz.test.js can prove Europe/Dublin output is byte-identical.
// Bodies are verbatim from origin/main 1d425ef3. TZ.18b deletes this file.
import { dublinTodayStr, dublinDayStr, dublinAddDays, dublinDayStartMs } from '@/lib/dublin-time'

// src/lib/agent/followups.js:146-153
const DUBLIN_HOUR_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false,
})
export function withinDublinDaytimeLegacyDublin(nowMs) {
  const hour = Number(DUBLIN_HOUR_FMT.format(new Date(nowMs)))
  return hour >= 9 && hour < 20
}

// src/lib/agent/core.js:58-95
function minutesOfDayInTz(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC',
    })
    const parts = fmt.formatToParts(date)
    const h = Number(parts.find(p => p.type === 'hour')?.value)
    const m = Number(parts.find(p => p.type === 'minute')?.value)
    if (Number.isNaN(h) || Number.isNaN(m)) return null
    return (h % 24) * 60 + m
  } catch {
    return null
  }
}
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}
export function isWithinQuietHoursLegacyDublin(now, quiet) {
  if (!quiet || !quiet.start || !quiet.end) return false
  const start = parseHHMM(quiet.start)
  const end = parseHHMM(quiet.end)
  if (start == null || end == null || start === end) return false
  const cur = minutesOfDayInTz(now, quiet.tz || 'Europe/Dublin')
  if (cur == null) return false
  if (start < end) return cur >= start && cur < end
  return cur >= start || cur < end
}

// src/lib/agent/followups.js:168-174 (proactiveWindowOpen)
export function proactiveWindowOpenLegacyDublin(nowMs, settings) {
  if (!withinDublinDaytimeLegacyDublin(nowMs)) return { open: false, reason: 'outside_daytime' }
  if (isWithinQuietHoursLegacyDublin(new Date(nowMs), settings?.quiet_hours)) {
    return { open: false, reason: 'operator_quiet_hours' }
  }
  return { open: true }
}

// src/lib/agent/review.js:43-51
export function reviewWindowLegacyDublin(nowMs = Date.now()) {
  const today = dublinDayStr(nowMs)
  const reviewDate = dublinAddDays(today, -1)
  return {
    reviewDate,
    startIso: new Date(dublinDayStartMs(reviewDate)).toISOString(),
    endIso: new Date(dublinDayStartMs(today)).toISOString(),
  }
}
// src/lib/agent/review.js:226 (the Monday digest gate)
export function isMondayLegacyDublin(nowMs) {
  return new Date(`${dublinDayStr(nowMs)}T12:00:00Z`).getUTCDay() === 1
}

// src/lib/agent/dublin-format.js:10-32
const DUBLIN_TIME_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
export function formatDublinClassTimeLegacyDublin(unixSec) {
  const parts = {}
  for (const p of DUBLIN_TIME_FMT.formatToParts(new Date(unixSec * 1000))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`
}

// src/lib/agent/event-date-label.js:5-23
const DUBLIN_DATE_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short',
})
export function dateLabelLegacyDublin(dateStr) {
  const parts = {}
  for (const p of DUBLIN_DATE_FMT.formatToParts(new Date(`${dateStr}T12:00:00Z`))) {
    parts[p.type] = p.value
  }
  return `${parts.weekday} ${parts.day} ${parts.month}`
}
export function dublinTodayLegacyDublin(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(nowMs))
}

// src/lib/whatsapp-flow/handler.js:19-25
export function flowDayLabelLegacyDublin(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(`${iso}T12:00:00Z`))
}
export function flowTimeLabelLegacyDublin(iso) {
  return new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

// auto-reply.js:795, followups.js:381, assistant/chat/route.js:516,
// cancellation-form/[token]/route.js:92,132 — all `dublinTodayStr()`.
export const dublinTodayStrLegacyDublin = dublinTodayStr

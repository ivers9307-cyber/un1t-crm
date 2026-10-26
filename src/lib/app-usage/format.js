// USAGE.1 — display helpers for the App usage page (pure, zone-aware).

import { dateKeyIn, addDaysIn, dayStartMsIn, timeLabelIn } from '@shared/zoned-time'

export function formatUsageDuration(seconds) {
  const s = Math.round(Number(seconds) || 0)
  if (s <= 0) return '—'
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  const rest = s % 60
  return rest ? `${m}m ${rest}s` : `${m}m`
}

export function formatPerDay(value) {
  const v = Number(value) || 0
  return v > 0 ? v.toFixed(1) : '—'
}

export function formatLastActive(iso, nowMs, zone) {
  if (!iso) return 'Never'
  const day = dateKeyIn(iso, zone)
  const today = dateKeyIn(nowMs, zone)
  const time = timeLabelIn(iso, zone)
  if (day === today) return `Today ${time}`
  if (day === addDaysIn(today, -1, zone)) return `Yesterday ${time}`
  const days = Math.round((dayStartMsIn(today, zone) - dayStartMsIn(day, zone)) / 86400_000)
  return `${days} days ago`
}

const MIN_BAR_PCT = 0.5

/**
 * Place one day's sessions on a horizontal strip. The strip runs 06:00–22:00
 * local, widened to whole hours when a session falls outside it; a session
 * that started the day before is clipped at midnight.
 * @returns {{ bars: {sessionId, platform, left, width, startedAt, endedAt}[], startHour: number, endHour: number }}
 */
export function timelineBars(sessions, day, zone) {
  const dayStart = dayStartMsIn(day, zone)
  const dayEnd = dayStartMsIn(addDaysIn(day, 1, zone), zone)
  const clipped = sessions.map((s) => ({
    ...s,
    s: Math.max(Date.parse(s.startedAt), dayStart),
    e: Math.min(Date.parse(s.endedAt), dayEnd),
  }))
  const hourOf = (ms) => (ms - dayStart) / 3600_000
  let startHour = 6
  let endHour = 22
  for (const c of clipped) {
    startHour = Math.min(startHour, Math.floor(hourOf(c.s)))
    endHour = Math.max(endHour, Math.ceil(hourOf(c.e)))
  }
  const spanMs = (endHour - startHour) * 3600_000
  const origin = dayStart + startHour * 3600_000
  const bars = clipped.map((c) => ({
    sessionId: c.sessionId,
    platform: c.platform,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    left: ((c.s - origin) / spanMs) * 100,
    width: Math.max(MIN_BAR_PCT, ((c.e - c.s) / spanMs) * 100),
  }))
  return { bars, startHour, endHour }
}

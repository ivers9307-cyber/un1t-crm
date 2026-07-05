// TAPO-T1 — pure schedule engine. Resolves a device's day into
// concrete on/off windows (UTC ms) and answers "what should this
// device be right now?". No DB, no network — TDD'd, TZ-safe via
// dublin-time's Intl-based day-start math (works regardless of
// server TZ).
//
// zone is a label in v1: class mode follows the LOCATION-WIDE
// timetable (class_occurrences has no zone column — mirrors
// class-climate exactly).

import { dublinDayStartMs } from '@/lib/dublin-time'

const DAY_MS = 24 * 3600 * 1000
const DEFAULT_LEAD_MIN = 15
const DEFAULT_LAG_MIN = 10

function hhmmToMs(dayStartMs, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return null
  return dayStartMs + (Number(m[1]) * 60 + Number(m[2])) * 60 * 1000
}

// ISO day-of-week (1=Mon..7=Sun) for a Dublin calendar date string.
function isoDow(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Sun
  return dow === 0 ? 7 : dow
}

// → [{ on_at, off_at }] (UTC ms), for the given Dublin date.
export function resolveDayWindows(device, dateStr, occurrences = []) {
  if (!device || !device.enabled) return []
  const dayStart = dublinDayStartMs(dateStr)

  if (device.schedule_mode === 'fixed') {
    const dow = isoDow(dateStr)
    const out = []
    for (const w of Array.isArray(device.fixed_windows) ? device.fixed_windows : []) {
      if (!Array.isArray(w?.days) || !w.days.includes(dow)) continue
      const onAt = hhmmToMs(dayStart, w.on)
      let offAt = hhmmToMs(dayStart, w.off)
      if (onAt == null || offAt == null) continue
      if (offAt <= onAt) offAt += DAY_MS // overnight span
      out.push({ on_at: onAt, off_at: offAt })
    }
    return out.sort((a, b) => a.on_at - b.on_at)
  }

  if (device.schedule_mode === 'class') {
    const live = (occurrences || []).filter(o => o && !o.cancelled_at)
    if (!live.length) return []
    const starts = live.map(o => new Date(o.starts_at).getTime())
    const ends = live.map(o => new Date(o.ends_at || o.starts_at).getTime())
    const lead = Number(device.class_rule?.lead_min ?? DEFAULT_LEAD_MIN)
    const lag = Number(device.class_rule?.lag_min ?? DEFAULT_LAG_MIN)
    return [{
      on_at: Math.min(...starts) - lead * 60 * 1000,
      off_at: Math.max(...ends) + lag * 60 * 1000,
    }]
  }

  return []
}

// → 'on' | 'off' | null (null = unmanaged; bridge must not touch it)
// Override is checked BEFORE the mode-none short-circuit so a manual
// toggle works on an adopted device that has no schedule yet.
export function desiredState(device, nowMs, dateStr, occurrences = []) {
  if (!device || !device.enabled) return null

  const ov = device.override
  if (ov && ov.state && ov.until && new Date(ov.until).getTime() > nowMs) {
    return ov.state === 'on' ? 'on' : 'off'
  }

  if (device.schedule_mode === 'none') return null

  const windows = resolveDayWindows(device, dateStr, occurrences)
  for (const w of windows) {
    if (nowMs >= w.on_at && nowMs < w.off_at) return 'on'
  }
  return 'off'
}

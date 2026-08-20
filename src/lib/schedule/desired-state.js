// TAPO-T1 — pure schedule engine. Resolves a device's day into
// concrete on/off windows (UTC ms) and answers "what should this
// device be right now?". No DB, no network — TDD'd, TZ-safe via
// dublin-time's Intl-based day-start math (works regardless of
// server TZ).
//
// zone is a label in v1: class mode follows the LOCATION-WIDE
// timetable (class_occurrences has no zone column — mirrors
// class-climate exactly).

import { addDaysISO } from '@/lib/dublin-time'

const DEFAULT_LEAD_MIN = 15
const DEFAULT_LAG_MIN = 10

const DUBLIN_TZ = 'Europe/Dublin'
const _partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBLIN_TZ,
  hour: '2-digit', minute: '2-digit', hour12: false,
})

// UTC-ms instant of a Dublin wall-clock HH:MM on a given calendar date.
//
// Resolves each boundary against ITS OWN Dublin day via the same
// guess-and-correct technique dublinDayStartMs uses for midnight — a flat
// offset from the midnight anchor is one hour wrong for any boundary after
// 01:00 on the spring-forward day (Dublin skips 01:00→02:00), because those
// wall-clock minutes sit on the far side of the +1h jump.
//
// One correction pass is exact for Dublin's ±1h DST. Edge cases:
//  - Nonexistent times (e.g. 01:30 on the spring-forward day) resolve to a
//    deterministic nearby instant (00:30 Dublin) — accepted, never fires a
//    duplicate/late window.
//  - Ambiguous times on the fall-back day (e.g. 01:30 on 2026-10-25, which
//    occurs twice) resolve deterministically to the SECOND occurrence
//    (the +00:00 / post-fall-back instant) — also accepted.
function dublinWallMs(dateStr, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return null
  const [y, mo, d] = dateStr.split('-').map(Number)
  const hh = Number(m[1])
  const mm = Number(m[2])
  // Naive guess: treat the wanted wall-clock as if it were UTC.
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0)
  // Read back what Dublin wall-clock that instant actually is, correct once.
  const parts = {}
  for (const { type, value } of _partsFmt.formatToParts(new Date(guess))) parts[type] = value
  const gotH = parts.hour === '24' ? 0 : Number(parts.hour)
  const gotMin = gotH * 60 + Number(parts.minute)
  const wantMin = hh * 60 + mm
  return guess - (gotMin - wantMin) * 60 * 1000
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

  if (device.schedule_mode === 'fixed') {
    const dow = isoDow(dateStr)
    const out = []
    for (const w of Array.isArray(device.fixed_windows) ? device.fixed_windows : []) {
      if (!Array.isArray(w?.days) || !w.days.includes(dow)) continue
      const onAt = dublinWallMs(dateStr, w.on)
      let offAt = dublinWallMs(dateStr, w.off)
      if (onAt == null || offAt == null) continue
      // Overnight span: re-resolve the off boundary on the NEXT calendar day
      // against its own Dublin wall-clock. A flat +24h is wrong across a DST
      // transition — Sat 22:00 → Sun 02:00 over spring-forward is 23 real
      // hours for the day, only 4 wall-clock hours but 3 real hours here.
      if (offAt <= onAt) offAt = dublinWallMs(addDaysISO(dateStr, 1), w.off)
      // `source` is the window this resolved pair came from. The engine
      // itself never reads it — it exists so a caller that needs the
      // window's payload (Sonos: volume + favourite) can get it without
      // re-deriving which window is active and re-doing the DST maths.
      out.push({ on_at: onAt, off_at: offAt, source: w })
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

// Serve set for a Dublin date: today's windows PLUS any still-live overnight
// tail from YESTERDAY's fixed windows. A Sat 22:00–02:00 window (days:[6]) is
// day-attributed to Saturday by resolveDayWindows; after midnight the serving
// date is Sunday, whose own windows are empty — without the tail the device
// gets cut off at 00:00. Both desiredState and the bridge's resolved_windows
// go through this so live and offline behaviour heal together.
//
// Class mode deliberately has NO yesterday spill: there are no overnight gym
// classes, and yesterday's occurrences aren't fetched by the directives route
// anyway. (A class STARTING today but ending after midnight still spills
// forward correctly — off_at = ends+lag regardless of date.)
export function resolveServeWindows(device, dateStr, occurrences = []) {
  if (!device || !device.enabled) return []
  const today = resolveDayWindows(device, dateStr, occurrences)
  if (device.schedule_mode !== 'fixed') return today
  const dayStartMs = dublinWallMs(dateStr, '00:00') // Dublin midnight of dateStr
  const tails = resolveDayWindows(device, addDaysISO(dateStr, -1), [])
    .filter(w => w.off_at > dayStartMs)
  if (!tails.length) return today
  return [...tails, ...today].sort((a, b) => a.on_at - b.on_at)
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

  const windows = resolveServeWindows(device, dateStr, occurrences)
  for (const w of windows) {
    if (nowMs >= w.on_at && nowMs < w.off_at) return 'on'
  }
  return 'off'
}

// TAPO-T1 (moved here by SONOS.1) — pure schedule engine. Resolves a
// day into concrete on/off windows (UTC ms) and answers "what should
// this be right now?". No DB, no network — TDD'd, and correct whatever
// the server TZ is (nothing here reads the host zone).
//
// ZONE-AWARE since SHELLY.2. Every entry point takes an optional IANA
// `tz` as its LAST argument, defaulting to Europe/Dublin so the existing
// Sonos callers are unchanged. A per-location caller passes
// locations.timezone — through resolveTz first, because that column is
// nullable free text and an invalid value must not throw inside a cron.
// The wall-clock maths itself lives in src/lib/tz-time.js, which is also
// where the DST-edge contract is written down (a nonexistent wall-clock
// resolves EARLIER; an ambiguous one resolves to one deterministic
// instant).
//
// SHELLY.2 also FIXED a live bug by that move. The private dublinWallMs
// this replaced corrected the naive guess by MINUTE-OF-DAY, which is a
// whole DAY late whenever the read-back rolls onto the next calendar
// date. For Dublin that is wall-clock 23:00-23:59 during IST, where a
// fixed_window boundary resolved a whole day late. Measured: sweeping
// every 30-minute boundary over all of 2026, old and new disagree on
// exactly the 23:xx boundaries and exactly the 210 IST dates, and on
// nothing else. No existing engine test covered a 23:xx boundary (they
// all use 22:00), and no live sonos_schedules window has one — the
// latest live boundary is 20:31 — so nothing in production moves. The
// behaviour change is deliberate and pinned by its own test.
//
// The TAPO-T1 tag is where this was born, not where it lives. The Tapo
// and Homey paths were deleted in SONOS.14; this engine was deliberately
// moved out of src/lib/tapo/ first so that deletion could not take it.
// Its consumer is now the Sonos planner (src/lib/sonos/groups.js), which
// calls resolveServeWindows for the ACTIVE WINDOW's identity and payload
// rather than desiredState's collapsed on/off — see planAction.
//
// A device's zone (the room label) is cosmetic in v1: class mode follows
// the LOCATION-WIDE timetable (class_occurrences has no zone column —
// mirrors class-climate exactly). Class windows are derived from
// occurrence INSTANTS, which are already absolute, so `tz` moves fixed
// windows only.

import { addDaysISO } from '@/lib/dublin-time'
import { wallMsInTz, dayStartMsInTz, DEFAULT_TZ } from '@/lib/tz-time'

const DEFAULT_LEAD_MIN = 15
const DEFAULT_LAG_MIN = 10

// ISO day-of-week (1=Mon..7=Sun) for a calendar date string. Zone-independent:
// a 'YYYY-MM-DD' names the same weekday everywhere, so this reads it as UTC.
function isoDow(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Sun
  return dow === 0 ? 7 : dow
}

// → [{ on_at, off_at }] (UTC ms), for the given LOCAL date in `tz`.
export function resolveDayWindows(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  if (!device || !device.enabled) return []

  if (device.schedule_mode === 'fixed') {
    const dow = isoDow(dateStr)
    const out = []
    for (const w of Array.isArray(device.fixed_windows) ? device.fixed_windows : []) {
      if (!Array.isArray(w?.days) || !w.days.includes(dow)) continue
      const onAt = wallMsInTz(dateStr, w.on, tz)
      let offAt = wallMsInTz(dateStr, w.off, tz)
      if (onAt == null || offAt == null) continue
      // Overnight span: re-resolve the off boundary on the NEXT calendar day
      // against its own local wall-clock. A flat +24h is wrong across a DST
      // transition — Sat 22:00 → Sun 02:00 over spring-forward is 23 real
      // hours for the day, only 4 wall-clock hours but 3 real hours here.
      if (offAt <= onAt) offAt = wallMsInTz(addDaysISO(dateStr, 1), w.off, tz)
      // `source` is the window this resolved pair came from. The engine
      // itself never reads it — it exists so a caller that needs the
      // window's payload (Sonos: volume + favourite) can get it without
      // re-deriving which window is active and re-doing the DST maths.
      // It's a shallow copy, not the caller's own window object, so a
      // consumer reading the payload can't reach back through it and
      // mutate the schedule it was given. Object.freeze(w) was considered
      // and rejected: w IS the caller's input, so freezing it in place
      // would mutate the caller's data structure as a side effect.
      out.push({ on_at: onAt, off_at: offAt, source: { ...w } })
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

// Serve set for a local date: today's windows PLUS any still-live overnight
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
export function resolveServeWindows(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  if (!device || !device.enabled) return []
  const today = resolveDayWindows(device, dateStr, occurrences, tz)
  if (device.schedule_mode !== 'fixed') return today
  // dayStartMsInTz, not wallMsInTz(dateStr, '00:00'): where DST starts at 00:00
  // local (Santiago, Havana, Beirut) that midnight does not exist, and the
  // general gap rule would put this boundary at 23:00 on the day BEFORE —
  // admitting a tail that has already finished. The day-start variant resolves
  // it to the first instant of the local day, which is what a boundary means.
  const dayStartMs = dayStartMsInTz(dateStr, tz)
  const tails = resolveDayWindows(device, addDaysISO(dateStr, -1), [], tz)
    .filter(w => w.off_at > dayStartMs)
  if (!tails.length) return today
  return [...tails, ...today].sort((a, b) => a.on_at - b.on_at)
}

// → 'on' | 'off' | null (null = unmanaged; bridge must not touch it)
// Override is checked BEFORE the mode-none short-circuit so a manual
// toggle works on an adopted device that has no schedule yet.
export function desiredState(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  if (!device || !device.enabled) return null

  const ov = device.override
  if (ov && ov.state && ov.until && new Date(ov.until).getTime() > nowMs) {
    return ov.state === 'on' ? 'on' : 'off'
  }

  if (device.schedule_mode === 'none') return null

  const windows = resolveServeWindows(device, dateStr, occurrences, tz)
  for (const w of windows) {
    if (nowMs >= w.on_at && nowMs < w.off_at) return 'on'
  }
  return 'off'
}

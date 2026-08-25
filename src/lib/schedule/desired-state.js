// TAPO-T1 (moved here by SONOS.1) — pure schedule engine. Resolves a
// day into concrete on/off windows (UTC ms) and answers "what should
// this be right now?". No DB, no network — TDD'd, and correct whatever
// the server TZ is (nothing here reads the host zone).
//
// ZONE-AWARE since SHELLY.2. Every entry point takes an optional IANA
// `tz` as its LAST argument, defaulting to Europe/Dublin so the existing
// Sonos callers are unchanged.
//
// THE `tz` CONTRACT — MECHANISM (what this file does):
//   • null, undefined and '' mean "no zone given" and resolve to Dublin.
//     locations.timezone is a NULLABLE column, so an absent value is a
//     normal value, not an error.
//   • Any other string goes to Intl unchanged, so a non-empty but INVALID
//     name THROWS a RangeError. This engine is the pure core: it has no
//     way to interpret 'Europe/Dubln' and does not invent one.
//   • That throw can only reach a path that resolves a wall-clock, which
//     means FIXED mode. A disabled device, schedule_mode 'none', a live
//     override and CLASS mode never touch the zone at all — class windows
//     come from occurrence INSTANTS, which are already absolute — so they
//     answer normally even when handed a garbage zone. That is not
//     tolerance, it is just that nothing asked.
//
// THE `tz` CONTRACT — POLICY (what the EDGE must do):
//   Whoever reads locations.timezone — the reconcile in Task 8, the routes
//   in PR 2 — must pass it through resolveTz() from src/lib/tz-time, which
//   downgrades an unusable value to Dublin, AND must emit an
//   operator-visible logWarn naming the location id and the rejected
//   value. resolveTz is pure and does NOT log, so that warning is the
//   caller's job, and it is the only thing standing between a typo'd zone
//   and a studio silently running on Dublin time. A schedule quietly an
//   hour out is a support ticket nobody knows how to open.
//
// The wall-clock maths itself lives in src/lib/tz-time.js, which is also
// where the DST-edge contract is written down (a nonexistent wall-clock
// resolves EARLIER; an ambiguous one resolves to one deterministic
// instant) and where the 23:xx-IST whole-day bug that SHELLY.2 fixed by
// moving onto it is documented in full. One line here: dublinWallMs
// corrected by minute-of-day, so any boundary whose read-back rolled onto
// the next calendar date resolved a whole day late.
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

// "No zone given" → Dublin. Deliberately NOT a validity check: anything else is
// handed to Intl as-is, so an invalid name surfaces as a RangeError rather than
// being silently swallowed into the default. `tz == null` covers undefined too,
// which the parameter default alone does not — an explicit null argument (the
// shape a nullable column arrives in) skips a default entirely.
const zoneOf = (tz) => (tz == null || tz === '' ? DEFAULT_TZ : tz)

// A '00:00' boundary means THE START OF THAT CALENDAR DAY, not "the wall-clock
// 00:00": where DST starts at local midnight (Santiago, Havana, Beirut) that
// wall-clock does not exist, and wallMsInTz's gap rule (earlier) would put the
// boundary at 23:00 on the day BEFORE — starting a window an hour early or
// ending it an hour early, on the wrong date. dayStartMsInTz resolves it to the
// first instant of the day instead, which is what a day boundary means.
const boundaryMs = (dateStr, hhmm, zone) => (
  hhmm === '00:00' ? dayStartMsInTz(dateStr, zone) : wallMsInTz(dateStr, hhmm, zone)
)

// ISO day-of-week (1=Mon..7=Sun) for a calendar date string. Zone-independent:
// a 'YYYY-MM-DD' names the same weekday everywhere, so this reads it as UTC.
function isoDow(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Sun
  return dow === 0 ? 7 : dow
}

// → [{ on_at, off_at }] (UTC ms), for the given LOCAL date in `tz`.
export function resolveDayWindows(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  const zone = zoneOf(tz)
  if (!device || !device.enabled) return []

  if (device.schedule_mode === 'fixed') {
    const dow = isoDow(dateStr)
    const out = []
    for (const w of Array.isArray(device.fixed_windows) ? device.fixed_windows : []) {
      if (!Array.isArray(w?.days) || !w.days.includes(dow)) continue
      const onAt = boundaryMs(dateStr, w.on, zone)
      let offAt = boundaryMs(dateStr, w.off, zone)
      if (onAt == null || offAt == null) continue
      // Overnight span: re-resolve the off boundary on the NEXT calendar day
      // against its own local wall-clock. A flat +24h is wrong across a DST
      // transition — Sat 22:00 → Sun 02:00 over spring-forward is 23 real
      // hours for the day, only 4 wall-clock hours but 3 real hours here.
      if (offAt <= onAt) offAt = boundaryMs(addDaysISO(dateStr, 1), w.off, zone)
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
  const zone = zoneOf(tz)
  if (!device || !device.enabled) return []
  const today = resolveDayWindows(device, dateStr, occurrences, zone)
  if (device.schedule_mode !== 'fixed') return today
  // dayStartMsInTz, not wallMsInTz(dateStr, '00:00'): where DST starts at 00:00
  // local (Santiago, Havana, Beirut) that midnight does not exist, and the
  // general gap rule would put this boundary at 23:00 on the day BEFORE —
  // admitting a tail that has already finished. The day-start variant resolves
  // it to the first instant of the local day, which is what a boundary means.
  const dayStartMs = dayStartMsInTz(dateStr, zone)
  const tails = resolveDayWindows(device, addDaysISO(dateStr, -1), [], zone)
    .filter(w => w.off_at > dayStartMs)
  if (!tails.length) return today
  return [...tails, ...today].sort((a, b) => a.on_at - b.on_at)
}

// → 'on' | 'off' | null (null = unmanaged; bridge must not touch it)
// Override is checked BEFORE the mode-none short-circuit so a manual
// toggle works on an adopted device that has no schedule yet.
export function desiredState(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  const zone = zoneOf(tz)
  if (!device || !device.enabled) return null

  const ov = device.override
  if (ov && ov.state && ov.until && new Date(ov.until).getTime() > nowMs) {
    return ov.state === 'on' ? 'on' : 'off'
  }

  if (device.schedule_mode === 'none') return null

  const windows = resolveServeWindows(device, dateStr, occurrences, zone)
  for (const w of windows) {
    if (nowMs >= w.on_at && nowMs < w.off_at) return 'on'
  }
  return 'off'
}

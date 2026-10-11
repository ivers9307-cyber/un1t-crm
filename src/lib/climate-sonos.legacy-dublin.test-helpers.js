// TZ.10 — FROZEN copies of the climate / Sonos functions this task made
// zone-aware, copied from origin/main 3608316a. Bodies are unchanged except:
// exported names gain a `Legacy` suffix, whole-line comments are dropped, the
// engine's internal calls point at the frozen engine below, and
// untilMidnightTonightIso's `Date.now()` became a `nowMs` argument (its only
// input) so it can be sampled. src/lib/climate-sonos.tz.test.js diffs the new
// code against these. Test-only: nothing in src/ imports this file. TZ.18b
// deletes it once the timezone wave has merged.
import { addDaysISO, dublinDayStr, dublinDateKey, dublinDayStartMs, dublinAddDays, dublinTimeLabel } from '@/lib/dublin-time'
import { wallMsInTz, dayStartMsInTz, DEFAULT_TZ } from '@/lib/tz-time'
import { playbackLabel } from '@/lib/sonos/playback'

// ── src/lib/schedule/desired-state.js (the engine) ─────────────────────────
const DEFAULT_LEAD_MIN = 15
const DEFAULT_LAG_MIN = 10

const zoneOf = (tz) => (tz == null || tz === '' ? DEFAULT_TZ : tz)

const boundaryMs = (dateStr, hhmm, zone) => (
  hhmm === '00:00' ? dayStartMsInTz(dateStr, zone) : wallMsInTz(dateStr, hhmm, zone)
)

function isoDow(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() // 0=Sun
  return dow === 0 ? 7 : dow
}

export function resolveDayWindowsLegacy(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
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
      if (offAt <= onAt) offAt = boundaryMs(addDaysISO(dateStr, 1), w.off, zone)
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

export function resolveServeWindowsLegacy(device, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  const zone = zoneOf(tz)
  if (!device || !device.enabled) return []
  const today = resolveDayWindowsLegacy(device, dateStr, occurrences, zone)
  if (device.schedule_mode !== 'fixed') return today
  const dayStartMs = dayStartMsInTz(dateStr, zone)
  const tails = resolveDayWindowsLegacy(device, addDaysISO(dateStr, -1), [], zone)
    .filter(w => w.off_at > dayStartMs)
  if (!tails.length) return today
  return [...tails, ...today].sort((a, b) => a.on_at - b.on_at)
}

export function desiredStateLegacy(device, nowMs, dateStr, occurrences = [], tz = DEFAULT_TZ) {
  const zone = zoneOf(tz)
  if (!device || !device.enabled) return null

  const ov = device.override
  if (ov && ov.state && ov.until && new Date(ov.until).getTime() > nowMs) {
    return ov.state === 'on' ? 'on' : 'off'
  }

  if (device.schedule_mode === 'none') return null

  const windows = resolveServeWindowsLegacy(device, dateStr, occurrences, zone)
  for (const w of windows) {
    if (nowMs >= w.on_at && nowMs < w.off_at) return 'on'
  }
  return 'off'
}

// ── src/lib/sonos/groups.js: planAction ─────────────────────────────────────
const arr = (v) => (Array.isArray(v) ? v : [])
const DEFAULT_VOLUME = 30

const toMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n          // "1756011600000"
    const d = new Date(v).getTime()           // "2026-08-24T05:00:00.000Z"
    return Number.isFinite(d) ? d : null
  }
  return null
}

export function planActionLegacy(schedule, nowMs, dateStr) {
  if (!schedule?.enabled) return null

  const ov = schedule.override
  if (ov?.state === 'off' && ov.until && new Date(ov.until).getTime() > nowMs) return null

  const windows = resolveServeWindowsLegacy(
    { enabled: true, schedule_mode: 'fixed', fixed_windows: arr(schedule.windows) },
    dateStr,
  )

  const last = schedule.last_applied
  const active = windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)

  if (active) {
    if (last && toMs(last.window_on_at) === active.on_at) return null
    const src = active.source || {}
    return {
      action: 'open',
      windowOnAt: active.on_at,
      volume: Number.isFinite(Number(src.volume)) ? Number(src.volume) : DEFAULT_VOLUME,
      favoriteId: src.favorite_id || null,
    }
  }

  if (last?.action === 'open') {
    const wo = toMs(last.window_on_at)
    if (wo !== null) return { action: 'close', windowOnAt: wo }
  }

  return null
}

// ── src/lib/sonos/reconcile.js:63 (and run-now:77): the one Dublin day ──────
export const sonosDateStrLegacy = (nowMs) => dublinDayStr(nowMs)

// ── src/components/automations/SonosScheduleClient.jsx ─────────────────────
export function fmtDublinLegacy(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

function isOverrideLive(override, nowMs) {
  return Boolean(override?.state === 'off' && override.until && new Date(override.until).getTime() > nowMs)
}

const HEALTH_GRACE_MS = 3 * 60_000
const HEALTH_OVERDUE_MS = 10 * 60_000


export function scheduleHealthLegacy(schedule, nowMs) {
  const lastAtIso = schedule.last_state?.at || null
  const lastAtMs = lastAtIso ? Date.parse(lastAtIso) : NaN
  const hasLastAt = Number.isFinite(lastAtMs)
  const playbackSuffix = schedule.last_state?.playback_state
    ? ` (Sonos reports ${playbackLabel(schedule.last_state.playback_state).toLowerCase()})` : ''

  const overridden = isOverrideLive(schedule.override, nowMs)
  const dateStr = dublinDayStr(nowMs)
  const windows = resolveServeWindowsLegacy(
    { enabled: true, schedule_mode: 'fixed', fixed_windows: Array.isArray(schedule.windows) ? schedule.windows : [] },
    dateStr,
  )
  const active = (schedule.enabled && !overridden)
    ? windows.find((w) => nowMs >= w.on_at && nowMs < w.off_at)
    : null

  if (active) {
    if (hasLastAt && lastAtMs >= active.on_at - HEALTH_GRACE_MS) {
      return { tone: 'green', label: 'Playing', detail: `Last acted ${fmtDublinLegacy(lastAtIso)}${playbackSuffix}.` }
    }
    if (nowMs - active.on_at > HEALTH_OVERDUE_MS) {
      return {
        tone: 'red',
        label: 'Should be playing — not applied',
        detail: `This window opened at ${fmtDublinLegacy(active.on_at)} and nothing has been recorded since. Check the sonos-reconcile cron and the Sonos connection.`,
      }
    }
    return {
      tone: 'amber',
      label: 'Window just opened',
      detail: `Opened at ${fmtDublinLegacy(active.on_at)} — waiting for the per-minute cron to apply it.`,
    }
  }

  if (overridden) {
    return {
      tone: 'grey',
      label: 'Overridden',
      detail: `Deliberately left alone until ${fmtDublinLegacy(schedule.override.until)} — see Override above.`,
    }
  }

  if (!hasLastAt) return { tone: 'grey', label: 'Not applied yet', detail: null }

  return {
    tone: 'grey',
    label: `Last acted ${fmtDublinLegacy(lastAtIso)}`,
    detail: `No window is open right now, so this only shows when the schedule last did something — it doesn't prove the cron is still running.${playbackSuffix}`,
  }
}

export function untilMidnightTonightIsoLegacy(nowMs) {
  const todayKey = dublinDateKey(nowMs)
  const tomorrowKey = dublinAddDays(todayKey, 1)
  return new Date(dublinDayStartMs(tomorrowKey)).toISOString()
}

// ── src/lib/class-climate.js: slotKey ──────────────────────────────────────
const SLOT_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Dublin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function slotKeyLegacy(startsAt) {
  if (!startsAt) return null
  const d = startsAt instanceof Date ? startsAt : new Date(startsAt)
  if (Number.isNaN(d.getTime())) return null
  const parts = SLOT_FMT.formatToParts(d)
  const wd = parts.find((p) => p.type === 'weekday')?.value || ''
  const hh = parts.find((p) => p.type === 'hour')?.value || ''
  const mm = parts.find((p) => p.type === 'minute')?.value || ''
  if (!wd || !hh || !mm) return null
  return `${wd} ${hh}:${mm}`
}

// ── src/lib/fleet-health.js: describeClass ──────────────────────────────────
export function describeClassLegacy(occ) {
  const name = typeof occ?.name === 'string' && occ.name.trim()
    ? occ.name.trim()
    : (typeof occ?.program === 'string' && occ.program.trim() ? occ.program.trim() : 'a class')
  const at = dublinTimeLabel(occ?.starts_at)
  return at ? `${name} ${at}` : name
}


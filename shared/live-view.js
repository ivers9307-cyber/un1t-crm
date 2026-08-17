// Live in-class view model — the member watches their OWN heart rate / zone /
// UN1T Points in real time during a class.
//
// Pure. No React, no Supabase, no env. Given ONE heart_rate_sessions row (the
// member's own OPEN session, read via the RLS-scoped client) + the current
// wall-clock ms, derive everything the /live screen renders.
//
// WHERE THE LIVE STATE COMES FROM (un1t-crm mig 354 + bridge-samples.js):
// the bridge maintains a RUNNING incremental aggregate ON the session row at
// ingest — the AUTHORITATIVE render columns hold the live value during a class:
//   zones_seconds   jsonb  running per-zone seconds  (→ zone bar + Burn)
//   effort_points   int    running UN1T Points
//   peak_hr_bpm     int    running peak
//   avg_hr_bpm      int    running average
//   live_last_bpm   int    the most-recent sample's bpm (current HR)
// plus staleness / lifecycle:
//   last_sample_at  tstz   max recorded_at so far (advances every batch)
//   max_hr_used     int    fixes the zone boundaries (same value finalisation uses)
//   class_name      text   the linked Glofox class name (may be null)
//   started_at      tstz   session start (elapsed timer)
//   ended_at        tstz   set once the class ends (→ "class complete")
//
// The live board trails the eventual finalisation by at most the pending
// sample's not-yet-known gap (≤5s) — the documented bounded live tail. Good
// enough for a live member view; endSession recomputes authoritatively.
//
// Reuses zoneForBpm / isBurn / burnSeconds / BURN_THRESHOLD_SECONDS from
// heart-rate.js so live zone/Burn math is byte-identical to the finalised view.

import {
  zoneForBpm,
  burnSeconds,
  isBurn,
  BURN_THRESHOLD_SECONDS,
  ZONE_DEFS,
} from './heart-rate.js'

// A sample older than this = the strap has (probably) dropped out. The bridge
// pushes ~1Hz and the live board polls every 2s, so 2 minutes of silence is a
// generous "reconnecting" threshold that won't false-positive on a brief blip.
export const STALE_AFTER_MS = 2 * 60 * 1000

function toMs(v) {
  if (v == null) return null
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

function finiteOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Derive the live view model from a single heart_rate_sessions row.
 *
 * Null-safe: a missing row (member not currently training) returns a fully
 * zeroed model with `active:false` so the screen can render its "no open
 * session / class complete" state without branching on undefined.
 *
 * @param {object|null|undefined} session  the member's OPEN heart_rate_sessions row
 * @param {number} [nowMs=Date.now()]
 * @returns {{
 *   active: boolean,            // there is a session row at all
 *   ended: boolean,            // ended_at set (class finished)
 *   stale: boolean,            // last sample > STALE_AFTER_MS old (strap reconnecting)
 *   currentBpm: number|null,   // live_last_bpm
 *   zone: object|null,         // ZONE_DEFS entry for currentBpm at max_hr_used
 *   maxHr: number|null,
 *   effortPoints: number,      // running UN1T Points
 *   peakBpm: number|null,
 *   avgBpm: number|null,
 *   zonesSeconds: object,      // { '1'..'5': seconds }
 *   burnSeconds: number,       // seconds in Z4+Z5
 *   isBurn: boolean,           // ≥12 min in Z4+ this session
 *   secondsToBurn: number,     // 720 − burnSeconds, clamped ≥0
 *   burnProgress: number,      // 0..1 toward the Burn threshold
 *   className: string|null,
 *   startedAtMs: number|null,
 *   elapsedSeconds: number,    // now − started_at, clamped ≥0
 *   lastSampleAtMs: number|null,
 * }}
 */
export function liveViewModel(session, nowMs = Date.now()) {
  const zonesSeconds = session?.zones_seconds && typeof session.zones_seconds === 'object'
    ? session.zones_seconds
    : {}

  const bSec = burnSeconds(zonesSeconds)
  const startedAtMs = toMs(session?.started_at)
  // last_sample_at is the staleness signal; fall back to live_last_at then
  // started_at so a freshly-created session (no samples yet) isn't born "stale".
  const lastSampleAtMs = toMs(session?.last_sample_at) ?? toMs(session?.live_last_at) ?? startedAtMs
  const endedAtMs = toMs(session?.ended_at)

  // Guard: max_hr_used null → Number(null) is 0, which would wrongly resolve a
  // zone. Require a positive finite value.
  const rawMaxHr = Number(session?.max_hr_used)
  const maxHr = Number.isFinite(rawMaxHr) && rawMaxHr > 0 ? rawMaxHr : null
  const rawBpm = Number(session?.live_last_bpm)
  const currentBpm = Number.isFinite(rawBpm) && rawBpm > 0 ? Math.round(rawBpm) : null
  // Only resolve a zone when we have BOTH a live bpm and a max — otherwise null
  // (the screen shows a neutral "waiting for your heart rate" state, not Zone 1).
  const zone = currentBpm != null && maxHr != null ? zoneForBpm(currentBpm, maxHr) : null

  const active = !!session
  const ended = !!endedAtMs
  // Only an ACTIVE, not-yet-ended session can be "stale". A finished session
  // isn't "reconnecting" — it's done.
  const stale = active && !ended && lastSampleAtMs != null && (nowMs - lastSampleAtMs) > STALE_AFTER_MS

  const secondsToBurn = Math.max(0, BURN_THRESHOLD_SECONDS - bSec)
  const burnProgress = BURN_THRESHOLD_SECONDS > 0
    ? Math.max(0, Math.min(1, bSec / BURN_THRESHOLD_SECONDS))
    : 0

  const elapsedSeconds = startedAtMs != null ? Math.max(0, Math.round((nowMs - startedAtMs) / 1000)) : 0

  return {
    active,
    ended,
    stale,
    currentBpm,
    zone,
    maxHr,
    effortPoints: Math.max(0, Math.round(finiteOr(session?.effort_points, 0))),
    peakBpm: Number.isFinite(Number(session?.peak_hr_bpm)) ? Math.round(Number(session.peak_hr_bpm)) : null,
    avgBpm: Number.isFinite(Number(session?.avg_hr_bpm)) ? Math.round(Number(session.avg_hr_bpm)) : null,
    zonesSeconds,
    burnSeconds: bSec,
    isBurn: isBurn(zonesSeconds),
    secondsToBurn,
    burnProgress,
    className: session?.class_name || null,
    startedAtMs,
    elapsedSeconds,
    lastSampleAtMs,
  }
}

/** Whole minutes (rounded down) in Zone 4+ so far — for the Burn copy. */
export function burnMinutes(zonesSeconds) {
  return Math.floor(burnSeconds(zonesSeconds) / 60)
}

/** Whole minutes remaining to earn the Burn (0 once earned). */
export function minutesToBurn(zonesSeconds) {
  return Math.ceil(Math.max(0, BURN_THRESHOLD_SECONDS - burnSeconds(zonesSeconds)) / 60)
}

/** "H:MM:SS" / "M:SS" elapsed clock from whole seconds. */
export function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

// Re-export the Z4+ accent colour (amber) so the screen's Burn UI stays in sync
// with the zone palette without re-importing ZONE_DEFS itself.
export const BURN_COLOR = ZONE_DEFS[3].color

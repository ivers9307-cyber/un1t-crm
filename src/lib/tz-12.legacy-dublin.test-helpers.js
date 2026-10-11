// TZ.12 — FROZEN copies of the TV / live-board time functions this task made
// zone-aware, copied verbatim from origin/main db552d75. Bodies are unchanged;
// only the exported names gain a `Legacy` suffix, and private helpers travel
// with them. src/lib/tz-12.tz.test.js and src/lib/tz-12.clocks.tz.test.js diff
// the new code against these. Test-only: nothing in src/ imports this file.
// TZ.18b deletes it once the wave merges.

import { dublinTimeLabel } from './dublin-time'
import { boardIsActive, ACTIVE_POLL_MS, IDLE_POLL_MS, OVERNIGHT_START_HOUR, OVERNIGHT_END_HOUR } from './live-poll'

// ── src/lib/live-poll.js ────────────────────────────────────────────────────
/** Hour-of-day in Dublin regardless of the device/server TZ. */
function dublinHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false,
  }).format(now))
}

/** Overnight = the only window where an idle board may back off. */
export function isOvernightLegacy(now = new Date()) {
  const h = dublinHour(now)
  return h >= OVERNIGHT_START_HOUR || h < OVERNIGHT_END_HOUR
}

/** Delay (ms) before the next poll after a successful fetch. */
export function nextPollDelayLegacy(payload, now = new Date()) {
  if (boardIsActive(payload)) return ACTIVE_POLL_MS
  return isOvernightLegacy(now) ? IDLE_POLL_MS : ACTIVE_POLL_MS
}

// ── src/lib/tv-class-intro.js ───────────────────────────────────────────────
export function demoIntroClassLegacy(nowMs = Date.now()) {
  let label = ''
  try {
    label = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(nowMs)
  } catch { label = '' }
  return {
    glofox_event_id: 'preview',
    starts_at: new Date(nowMs).toISOString(),
    class_name: 'STRENGTH',
    starts_at_label: label,
    program: 'Preview',
  }
}

// ── src/lib/live-board.js (the current_class.starts_at_label expression) ────
export const currentClassLabelLegacy = (startsAt) => dublinTimeLabel(startsAt)

// ── src/app/live/[locationId]/DetectedTab.jsx ───────────────────────────────
export function formatDateTimeLegacy(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' }).format(new Date(iso))
  } catch { return iso }
}

// ── the board clocks: the screen's OWN clock (host zone) ────────────────────
// src/app/tv/live/[token]/LiveTvClient.jsx header
export const liveTvClockLegacy = (now) =>
  now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
// src/app/tv/live/[token]/challenges/ChallengeTvClient.jsx header
export const challengeTvClockLegacy = (now) =>
  now.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })
// src/app/tv/cast/[token]/TVDisplay.jsx IdleView
export function idleClockLegacy(now) {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const day = now.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })
  return { hh, mm, day }
}

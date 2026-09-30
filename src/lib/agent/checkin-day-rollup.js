// src/lib/agent/checkin-day-rollup.js
// CHECKINSTALL.1 — a per-Dublin-day tally of the first-class check-in runner.
// runFirstClassCheckins returns one tick's counts; the agent-followups route
// used to write only that onto cron_heartbeats.last_outcome.checkins, so every
// tick overwrote the last and from 20:00 the row said only "quiet_hours". A day
// of silent skips (C98: human_active on every app-booked first-timer) left no
// trace. The route now folds each tick into last_outcome.checkins_day with this,
// keeping the day before as `previous`. Counts are per TICK evaluation, not per
// person: one lead skipped for 8 hours shows human_active ×32. Pure.

const COUNTS = ['candidates', 'freeform', 'templates', 'skipped']

function emptyDay(day) {
  return { day, ticks: 0, daytime_ticks: 0, failed_ticks: 0, candidates: 0, freeform: 0, templates: 0, skipped: 0, reasons: {} }
}

function withoutPrevious(d) {
  const { previous: _drop, ...rest } = d
  return rest
}

/**
 * @param {object|null} prev  the previous last_outcome.checkins_day (null = none)
 * @param {object|null} tick  this tick's runFirstClassCheckins() result; null when it threw
 * @param {{ day: string, carryFailed?: boolean }} opts
 *   day — Europe/Dublin YYYY-MM-DD of this tick (dublinDayStr).
 *   carryFailed — the previous heartbeat could not be READ. Today's totals then
 *   restart here and carry carry_failed:true for the rest of the day: a failed
 *   read is never passed off as an empty morning.
 */
export function rollupCheckinDay(prev, tick, { day, carryFailed = false }) {
  const valid = !!prev && typeof prev === 'object' && typeof prev.day === 'string'
  const sameDay = valid && prev.day === day
  const out = sameDay
    ? { ...emptyDay(day), ...prev, reasons: { ...(prev.reasons || {}) } }
    : { ...emptyDay(day), previous: valid ? withoutPrevious(prev) : null }
  if (carryFailed) out.carry_failed = true
  out.ticks += 1
  if (!tick) { out.failed_ticks += 1; return out }
  if (tick.reason === 'quiet_hours') return out
  out.daytime_ticks += 1
  for (const k of COUNTS) out[k] += Number(tick[k]) || 0
  for (const [r, n] of Object.entries(tick.reasons || {})) {
    out.reasons[r] = (out.reasons[r] || 0) + (Number(n) || 0)
  }
  return out
}

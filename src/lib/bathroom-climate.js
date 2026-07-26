// BATHROOM-CLIMATE.1 — pure scheduling logic for the bathroom-climate
// automation. No DB / no vendor calls (safe to import from client
// components). The IO lives in bathroom-climate-runner.js.
//
// Timing model (deliberately different from class-climate): the bathroom
// units come on a fixed delay AFTER a class STARTS — when people hit the
// showers — and run on a fixed timer. Class END time is irrelevant.

import { slotKey, classMatchesFilter } from '@/lib/class-climate'

export const DEFAULT_CONFIG = Object.freeze({
  device_ids: [],
  delay_after_start_min: 45, // turn AC on this many minutes AFTER class start
  run_duration_min: 30,      // off timer — minutes from the scheduled on-time
  class_filter: [],          // [] = all classes; else only names containing one of these (case-insensitive)
  excluded_slots: [],        // recurring "<weekday> HH:MM" (Dublin) slots to skip, e.g. "Thu 06:00"
})

/**
 * Merge a stored config blob over the defaults, coercing types so a
 * hand-edited JSONB can't crash the runner. run_duration_min floors at 1 —
 * a 0-minute run would put auto_off_at at/before the on-time.
 */
export function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    device_ids: Array.isArray(c.device_ids) ? c.device_ids.filter(Boolean) : [],
    delay_after_start_min: Math.max(0, num(c.delay_after_start_min, DEFAULT_CONFIG.delay_after_start_min)),
    run_duration_min: Math.max(1, num(c.run_duration_min, DEFAULT_CONFIG.run_duration_min)),
    class_filter: Array.isArray(c.class_filter)
      ? c.class_filter.filter(Boolean).map((s) => String(s).toLowerCase())
      : [],
    excluded_slots: Array.isArray(c.excluded_slots)
      ? c.excluded_slots.filter(Boolean).map((s) => String(s))
      : [],
  }
}

/**
 * Pure: which classes should the bathroom AC be turned ON for right now?
 *
 * Window per occurrence: [start + delay, start + delay + duration]. Fire
 * when now is inside it AND the class passes the include-filter AND its
 * weekly slot isn't excluded. Both-sided check means a cron catching up
 * after downtime never blasts ONs for windows that already closed.
 *
 * The OFF is NOT planned here — the runner sets ac_sessions.auto_off_at
 * via autoOffAtFor and the existing ac-auto-off cron performs it.
 *
 * @param {{ occurrences: Array, config: object, nowMs?: number }} args
 * @returns {Array<{ glofox_event_id: string, occurrence: object }>}
 */
export function planBathroomClimate({ occurrences, config, nowMs = Date.now() }) {
  const excluded = new Set(config.excluded_slots || [])
  const out = []
  for (const occ of occurrences || []) {
    if (!occ?.glofox_event_id || !occ.starts_at) continue
    if (!classMatchesFilter(occ, config.class_filter)) continue
    if (excluded.has(slotKey(occ.starts_at))) continue
    const startMs = new Date(occ.starts_at).getTime()
    if (!Number.isFinite(startMs)) continue
    const windowOpen = startMs + config.delay_after_start_min * 60_000
    const windowClose = windowOpen + config.run_duration_min * 60_000
    if (nowMs >= windowOpen && nowMs <= windowClose) {
      out.push({ glofox_event_id: occ.glofox_event_id, occurrence: occ })
    }
  }
  return out
}

/**
 * Pure: auto_off_at anchored to the class schedule (start + delay +
 * duration) — a late cron tick still switches off at the same wall-clock
 * time. Never returns a past time (clamps to now + 60s).
 */
export function autoOffAtFor(occurrence, config, nowMs = Date.now()) {
  const startMs = new Date(occurrence.starts_at).getTime()
  const off = startMs + (config.delay_after_start_min + config.run_duration_min) * 60_000
  return new Date(Math.max(off, nowMs + 60_000)).toISOString()
}

// SCREENMODE.2 — pure planner for the Hatch floor screens. Turns class
// occurrences + a config into merged "class app" time windows, and answers
// "what mode should a screen be in right now". No DB / no vendor calls (safe
// to import from client components); the IO lives with the routes and cron.
// Sibling of class-climate.js, whose slotKey/classMatchesFilter it reuses.

import { slotKey, classMatchesFilter } from '@/lib/class-climate'
import { DEFAULT_TZ } from '@shared/zoned-time'

export const SCREEN_MODE_KEY = 'screen_mode'
export const SCREEN_MODES = Object.freeze(['class_app', 'marketing'])
// What a box may report back: the two modes, or 'unknown' when it cannot tell.
export const REPORTED_MODES = Object.freeze(['class_app', 'marketing', 'unknown'])
export const OVERRIDE_MINUTES = Object.freeze([30, 60, 120, 240])

// The only config value a box acts on, so it is validated at write time and
// again here. A dotted Android package name; never shell text.
export const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
export const PACKAGE_NAME_MAX = 200

export const PLAN_LOOKBACK_MS = 6 * 3_600_000
export const PLAN_LOOKAHEAD_MS = 36 * 3_600_000
export const PLAN_POLL_SECONDS = 600
export const DEFAULT_CLASS_MS = 3_600_000

export const DEFAULT_SCREEN_CONFIG = Object.freeze({
  device_names: [],
  class_app_package: null,
  lead_in_min: 10,    // show the class app this many minutes before class start
  lead_out_min: 5,    // ...and keep it this many minutes after class end
  class_filter: [],   // [] = all classes; else only names containing one of these (case-insensitive)
  excluded_slots: [], // recurring "<weekday> HH:MM" slots (the location's wall clock) to skip
  stale_plan_mode: 'class_app', // what a box shows when its plan has gone stale
})

/**
 * Merge a stored config blob over the defaults, coercing types so a
 * hand-edited JSONB can't crash the planner or reach a box as shell text.
 */
export function resolveScreenConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [])
  const pkg = c.class_app_package
  return {
    device_names: strings(c.device_names),
    class_app_package:
      typeof pkg === 'string' && pkg.length <= PACKAGE_NAME_MAX && PACKAGE_NAME_RE.test(pkg) ? pkg : null,
    lead_in_min: Math.max(0, num(c.lead_in_min, DEFAULT_SCREEN_CONFIG.lead_in_min)),
    lead_out_min: Math.max(0, num(c.lead_out_min, DEFAULT_SCREEN_CONFIG.lead_out_min)),
    class_filter: strings(c.class_filter).map((s) => s.toLowerCase()),
    excluded_slots: strings(c.excluded_slots),
    stale_plan_mode: SCREEN_MODES.includes(c.stale_plan_mode)
      ? c.stale_plan_mode
      : DEFAULT_SCREEN_CONFIG.stale_plan_mode,
  }
}

/**
 * Pure: the merged time windows in which the screens should show the class
 * app. Each qualifying occurrence opens `lead_in_min` before it starts and
 * closes `lead_out_min` after it ends; windows that overlap or touch are
 * merged. Cancelled rows must already be excluded by the caller.
 *
 * `zone` is the location's IANA zone; only the excluded-slot match reads it.
 *
 * @param {{ occurrences: Array, config: object, zone?: string }} args
 * @returns {Array<{ from: string, until: string, classes: Array<{ id: string, name: string|null, starts_at: string, ends_at: string }> }>}
 */
export function planScreenWindows({ occurrences, config, zone = DEFAULT_TZ }) {
  const cfg = config || DEFAULT_SCREEN_CONFIG
  const excluded = new Set(cfg.excluded_slots || [])
  const leadIn = (cfg.lead_in_min ?? DEFAULT_SCREEN_CONFIG.lead_in_min) * 60_000
  const leadOut = (cfg.lead_out_min ?? DEFAULT_SCREEN_CONFIG.lead_out_min) * 60_000

  const raw = []
  for (const occ of occurrences || []) {
    if (!occ?.glofox_event_id || !occ.starts_at) continue
    const startMs = new Date(occ.starts_at).getTime()
    if (!Number.isFinite(startMs)) continue
    if (!classMatchesFilter(occ, cfg.class_filter)) continue
    if (excluded.has(slotKey(occ.starts_at, zone))) continue
    let endMs = occ.ends_at ? new Date(occ.ends_at).getTime() : NaN
    if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + DEFAULT_CLASS_MS
    raw.push({
      fromMs: startMs - leadIn,
      untilMs: endMs + leadOut,
      cls: {
        id: occ.glofox_event_id,
        name: occ.name ?? null,
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
      },
    })
  }

  raw.sort((a, b) => a.fromMs - b.fromMs)
  const merged = []
  for (const r of raw) {
    const last = merged[merged.length - 1]
    if (last && last.untilMs >= r.fromMs) {
      last.untilMs = Math.max(last.untilMs, r.untilMs)
      last.classes.push(r.cls)
    } else {
      merged.push({ fromMs: r.fromMs, untilMs: r.untilMs, classes: [r.cls] })
    }
  }
  return merged.map((w) => ({
    from: new Date(w.fromMs).toISOString(),
    until: new Date(w.untilMs).toISOString(),
    classes: w.classes,
  }))
}

/**
 * Pure: the mode a screen should be in at `nowMs`. A live override (until >
 * now, known mode) wins; else class_app inside any window; else marketing.
 * An override with a missing or unparseable `until` has lapsed.
 *
 * @param {{ windows?: Array<{ from: string, until: string }>, override?: { mode: string, until: string }|null }} plan
 * @param {number} nowMs
 * @returns {'class_app'|'marketing'}
 */
export function modeAt({ windows, override } = {}, nowMs) {
  if (override && SCREEN_MODES.includes(override.mode)) {
    const untilMs = override.until ? new Date(override.until).getTime() : NaN
    if (Number.isFinite(untilMs) && untilMs > nowMs) return override.mode
  }
  for (const w of windows || []) {
    if (nowMs >= Date.parse(w.from) && nowMs < Date.parse(w.until)) return 'class_app'
  }
  return 'marketing'
}

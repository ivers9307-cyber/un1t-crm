// CLASS-CLIMATE.1 — pure scheduling logic for the class-climate
// automation. No DB / no vendor calls — just "given the upcoming
// classes, the config, and the clock, which classes' AC window is open
// right now?". The IO lives in class-climate-runner.js.

export const DEFAULT_CONFIG = Object.freeze({
  device_ids: [],
  offset_on_min: 15,   // turn AC on this many minutes before class start
  offset_off_min: 5,   // turn AC off this many minutes after class end
  class_filter: [],    // [] = all classes; else only names containing one of these (case-insensitive)
})

const DEFAULT_DURATION_MS = 60 * 60_000

/**
 * Merge a stored config blob over the defaults, coercing types so a
 * hand-edited JSONB can't crash the runner.
 */
export function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    device_ids: Array.isArray(c.device_ids) ? c.device_ids.filter(Boolean) : [],
    offset_on_min: Math.max(0, num(c.offset_on_min, DEFAULT_CONFIG.offset_on_min)),
    offset_off_min: Math.max(0, num(c.offset_off_min, DEFAULT_CONFIG.offset_off_min)),
    class_filter: Array.isArray(c.class_filter)
      ? c.class_filter.filter(Boolean).map((s) => String(s).toLowerCase())
      : [],
  }
}

/**
 * Pure: does this occurrence pass the (optional) class-name filter?
 * Empty filter = all classes match.
 */
export function classMatchesFilter(occurrence, classFilter) {
  if (!Array.isArray(classFilter) || classFilter.length === 0) return true
  const name = String(occurrence?.name || '').toLowerCase()
  return classFilter.some((f) => name.includes(f))
}

/**
 * Pure: which classes should the AC be turned ON for right now?
 *
 * Fire ON when:  (starts_at - offset_on) <= now <= ends_at
 *   i.e. we're inside the pre-class lead window or the class is running,
 *   AND the class passes the filter.
 *
 * The OFF is NOT planned here — the runner sets the ac_sessions
 * auto_off_at to (ends_at + offset_off) and the existing ac-auto-off
 * cron performs it.
 *
 * @param {{ occurrences: Array, config: object, nowMs?: number }} args
 * @returns {Array<{ glofox_event_id: string, occurrence: object, endMs: number }>}
 */
export function planClassClimate({ occurrences, config, nowMs = Date.now() }) {
  const out = []
  for (const occ of occurrences || []) {
    if (!occ?.glofox_event_id || !occ.starts_at) continue
    if (!classMatchesFilter(occ, config.class_filter)) continue
    const startMs = new Date(occ.starts_at).getTime()
    const endMs = occ.ends_at ? new Date(occ.ends_at).getTime() : startMs + DEFAULT_DURATION_MS
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    const windowOpen = startMs - config.offset_on_min * 60_000
    if (nowMs >= windowOpen && nowMs <= endMs) {
      out.push({ glofox_event_id: occ.glofox_event_id, occurrence: occ, endMs })
    }
  }
  return out
}

/**
 * Pure: the auto_off_at for a turned-on class = class end + offset_off.
 * Never returns a time in the past (clock skew / very short class) — at
 * least a minute out so the auto-off cron doesn't immediately reverse us.
 */
export function autoOffAtFor(occurrence, config, nowMs = Date.now()) {
  const startMs = new Date(occurrence.starts_at).getTime()
  const endMs = occurrence.ends_at ? new Date(occurrence.ends_at).getTime() : startMs + DEFAULT_DURATION_MS
  const off = endMs + config.offset_off_min * 60_000
  return new Date(Math.max(off, nowMs + 60_000)).toISOString()
}

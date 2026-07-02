// Pure trigger for the studio TV class-start intro card. No DOM/IO.
// The TV page passes the live class + the last-played key + the server clock.

export const INTRO_WINDOW_MS = 120_000  // only fire within 2 min of scheduled start
export const INTRO_DURATION_MS = 8_000  // how long the card holds before dissolving

/**
 * Should the intro card play right now?
 * Plays once, at scheduled start, within a 2-min window, per occurrence.
 * @param {{ currentClass: {glofox_event_id?:string, starts_at?:string}|null, lastPlayedKey: string|null, nowMs: number, windowMs?: number }} args
 */
export function shouldPlayIntro({ currentClass, lastPlayedKey, nowMs, windowMs = INTRO_WINDOW_MS }) {
  const key = currentClass?.glofox_event_id
  const startMs = currentClass?.starts_at ? Date.parse(currentClass.starts_at) : NaN
  if (!key || !Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false
  if (key === lastPlayedKey) return false
  const since = nowMs - startMs
  return since >= 0 && since <= windowMs
}

// Delays (ms) for the three transition steps the intro card runs, relative
// to when the effect fires. Kept here so the plan is fully described in one
// pure place and the component just executes the returned timers.
export const INTRO_SHOW_DELAY_MS = 30              // mount → shown=true (fade/scale in)
export const INTRO_FADE_DELAY_MS = INTRO_DURATION_MS - 600  // shown=false (fade out)
export const INTRO_HIDE_DELAY_MS = INTRO_DURATION_MS        // unmount (visible=false)

/**
 * Decide, for ONE run of the intro effect, whether to (re)start the
 * show→fade→hide sequence for the current occurrence.
 *
 * The effect must depend ONLY on the occurrence identity (glofox_event_id),
 * NOT on the 2s server-clock poll — otherwise every poll tears down the
 * in-flight fade/hide timers and re-runs the effect, which (because the
 * occurrence has already been marked played) early-returns without rearming
 * them, leaving the full-screen overlay stuck over the live board. This
 * controller makes that decision explicit and unit-testable:
 *
 *   - `play: true`  → the component should mark the occurrence played,
 *     set visible, and arm the timers in `timers`.
 *   - `play: false` → do nothing (either nothing to show, or this occurrence
 *     already played — do NOT clear anything that's in flight).
 *
 * @param {{ eventId: string|null|undefined, startsAt: string|null|undefined,
 *           lastPlayedKey: string|null, nowMs: number, windowMs?: number }} args
 * @returns {{ play: boolean, key: string|null,
 *             timers: { showMs: number, fadeMs: number, hideMs: number } | null }}
 */
export function planIntroTimers({ eventId, startsAt, lastPlayedKey, nowMs, windowMs = INTRO_WINDOW_MS }) {
  const currentClass = eventId ? { glofox_event_id: eventId, starts_at: startsAt } : null
  if (!shouldPlayIntro({ currentClass, lastPlayedKey, nowMs, windowMs })) {
    return { play: false, key: null, timers: null }
  }
  return {
    play: true,
    key: eventId,
    timers: { showMs: INTRO_SHOW_DELAY_MS, fadeMs: INTRO_FADE_DELAY_MS, hideMs: INTRO_HIDE_DELAY_MS },
  }
}

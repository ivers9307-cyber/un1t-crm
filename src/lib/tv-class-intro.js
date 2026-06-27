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

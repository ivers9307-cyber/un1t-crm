// Adaptive poll cadence for the always-on live boards (studio TV + coach view).
//
// The board payload only changes while something is live: an open HR session, a
// strap broadcasting, a running class timer, or a scheduled class in progress.
// Outside those windows the board is static, yet a kiosk TV left on all day (or
// overnight) keeps polling the Node function every few seconds — pure Vercel
// Fluid-compute cost for a screen showing "no live class".
//
// So the boards back off to a slow IDLE cadence when nothing is live, and run
// at the ACTIVE cadence otherwise. A board wakes to ACTIVE within one idle
// interval as soon as a strap connects or a class/timer starts — imperceptible
// at class start (nobody is mid-effort in the first ~30s) and it removes the
// bulk of the all-day/overnight polls. Pure so both boards share one definition
// and it can be unit-tested without a DOM.

export const ACTIVE_POLL_MS = 4000
export const IDLE_POLL_MS = 30000

/**
 * Is there anything live worth refreshing at the fast cadence?
 * Covers both payload shapes: the public TV board (`timer`, `current_class`)
 * and the coach view (`occurrence`). Unknown / null payload → treat as active
 * so we never idle before we have data.
 */
export function boardIsActive(payload) {
  if (!payload) return true
  return (
    (payload.sessions?.length ?? 0) > 0 ||
    (payload.available_straps?.length ?? 0) > 0 ||
    Boolean(payload.timer) ||
    Boolean(payload.current_class) ||
    Boolean(payload.occurrence)
  )
}

/** Delay (ms) before the next poll after a successful fetch. */
export function nextPollDelay(payload) {
  return boardIsActive(payload) ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

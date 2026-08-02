// Adaptive poll cadence for the always-on live boards (studio TV + coach view).
//
// The board payload only changes while something is live: an open HR session, a
// strap broadcasting, a running class timer, or a scheduled class in progress.
// Outside those windows the board is static, yet a kiosk TV left on all day (or
// overnight) keeps polling the Node function every few seconds — pure Vercel
// Fluid-compute cost for a screen showing "no live class".
//
// So the boards back off to a slow IDLE cadence when nothing is live, and run
// at the ACTIVE cadence otherwise. TV-POLL-FAST.1: the idle back-off is now
// OVERNIGHT-ONLY (22:00–06:00 Dublin). The 30s idle interval made a coach's
// "Start" take up to 30s to appear on the TV whenever no class/strap was
// already live (e.g. events) — unacceptable on the floor. During opening
// hours an idle board keeps the ACTIVE cadence so a timer start shows within
// one 4s poll; the overnight window still removes the bulk of the wasted
// polls (a kiosk left on all night). Pure so both boards share one definition
// and it can be unit-tested without a DOM.

export const ACTIVE_POLL_MS = 4000
export const IDLE_POLL_MS = 30000
export const OVERNIGHT_START_HOUR = 22 // Dublin wall-clock, inclusive
export const OVERNIGHT_END_HOUR = 6    // Dublin wall-clock, exclusive

/** Hour-of-day in Dublin regardless of the device/server TZ. */
function dublinHour(now) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false,
  }).format(now))
}

/** Overnight = the only window where an idle board may back off. */
export function isOvernight(now = new Date()) {
  const h = dublinHour(now)
  return h >= OVERNIGHT_START_HOUR || h < OVERNIGHT_END_HOUR
}

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
export function nextPollDelay(payload, now = new Date()) {
  if (boardIsActive(payload)) return ACTIVE_POLL_MS
  return isOvernight(now) ? IDLE_POLL_MS : ACTIVE_POLL_MS
}

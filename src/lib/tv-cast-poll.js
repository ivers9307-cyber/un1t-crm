// SCREENMODE.9 — how often the public cast page (/tv/cast/<token>) polls its
// content endpoint for a push.
//
// A browser casting to a TV polls every CAST_POLL_MS. The Hatch Street Android
// TV boxes load the page with ?kiosk=1 and poll only every CAST_KIOSK_POLL_MS:
// a content push rings their doorbell so they reload at once, and the slow poll
// is just the safety net. Six web views at 6 s would be millions of requests a
// month.

export const CAST_POLL_MS = 6000
export const CAST_KIOSK_POLL_MS = 60_000

/** True only for the exact string '1' (the `?kiosk=1` query value). */
export function isKioskParam(value) {
  return value === '1'
}

/** The poll interval for a cast page, in milliseconds. */
export function castPollMs(kiosk) {
  return kiosk ? CAST_KIOSK_POLL_MS : CAST_POLL_MS
}

// ROSTER-FIX.7 — one decision table for "what does this week's fetch do to the
// Schedule tab?", lifted out of app/(staff)/(tabs)/schedule.jsx so it can be
// tested: the root vitest only collects mobile/lib/**, so screen logic is
// untestable until it lives here.
//
// Three outcomes, and only the last one is destructive:
//
//   success        take the new rows, clear the banner.
//   transport      KEEP the last-good rows and show a non-destructive banner.
//                  api() mints `transport: true` when it never got a usable
//                  API answer (a dropped fetch, a failed session refresh, or a
//                  non-JSON page — an HTML 5xx or 404 from the edge counts, so
//                  this is not only "the request never left the phone"). The
//                  week already on screen is still
//                  the truth, so blanking it told a coach on a 5G handover
//                  that they had no shifts. See mobile/lib/api.js.
//   API failure    the server DID answer and said no. Empty the list and show
//                  what it said, because the old rows may no longer be the
//                  caller's to see (a location switch, a revoked role).

// Plain hyphen, no em dash — Richard's rule for anything a human reads.
export const TRANSPORT_ERROR = 'Couldn’t refresh - showing the last loaded week'

/**
 * @param {Array|null} prev  the rows currently on screen (last-good)
 * @param {object|null} res  an api() envelope: { success, data?, error?, transport? }
 * @param {object} [opts]
 * @param {string} [opts.fallbackError] copy for an API failure with no message
 * @returns {{ shifts: Array, error: string|null }}
 */
export function applyWeekResult(prev, res, { fallbackError = 'Failed to load shifts' } = {}) {
  const lastGood = Array.isArray(prev) ? prev : []
  if (res?.success) return { shifts: Array.isArray(res.data) ? res.data : [], error: null }
  if (res?.transport) return { shifts: lastGood, error: TRANSPORT_ERROR }
  return { shifts: [], error: res?.error || fallbackError }
}

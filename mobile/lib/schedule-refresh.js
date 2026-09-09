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
//                  ROSTER-FIX.7g — "the week already on screen" only holds
//                  while the QUESTION is unchanged. `prev` must therefore be
//                  the rows for the current location + user + week + view and
//                  nothing else: see lastGoodFor() below, which is what the
//                  caller passes in. A first fetch that fails at transport
//                  level right after a context change has no last-good of its
//                  own, and replaying the previous context's rows would paint
//                  another studio's roster (or another user's week) under the
//                  new header — a worse lie than the empty state.
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

// ROSTER-FIX.7g — the identity of the question the week on screen answers.
// Four things change it, and every one of them makes the rows already loaded
// somebody else's: the active location (studio switch), the profile ("View as
// user" / impersonation), the week being shown, and the Me / Team / Manage
// view. Built here rather than inline in the screen so the shape is pinned by
// a test and cannot quietly lose a field.
export function weekKey({ locationId, profileId, weekStartIso, view } = {}) {
  return `${locationId ?? ''}|${profileId ?? ''}|${weekStartIso ?? ''}|${view ?? ''}`
}

/**
 * The last-good rows, but only if they belong to `key`. Anything else — a
 * different context, an empty ref, a shape we don't recognise — is [].
 *
 * @param {{ key?: string, shifts?: Array, timeOff?: Array }|null} lastGood
 * @param {string} key    the key of the fetch being applied
 * @param {'shifts'|'timeOff'} [which]
 * @returns {Array}
 */
export function lastGoodFor(lastGood, key, which = 'shifts') {
  if (!lastGood || !key || lastGood.key !== key) return []
  const rows = lastGood[which]
  return Array.isArray(rows) ? rows : []
}

/**
 * ROSTER-FIX.7g — in-flight sequencing. Two fetches can be in the air at once
 * (the load effect and the focus effect, a pull-to-refresh across a week
 * change, a location switch mid-request) and the one that resolves LAST wins
 * the screen, even when it is answering the older question. Each fetch takes a
 * stamp; a response whose stamp is no longer the current one is dropped on the
 * floor — no state write, and no last-good update either, because a superseded
 * answer must not become the rows a later transport failure falls back on.
 *
 * @param {*} current the stamp of the newest fetch started
 * @param {*} mine    the stamp this response was issued under
 */
export function isStaleResponse(current, mine) {
  return current !== mine
}

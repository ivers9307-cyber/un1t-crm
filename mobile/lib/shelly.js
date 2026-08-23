// mobile/lib/shelly.js
// SHELLY-MOB.1 — the pure half of the mobile Smart plugs screen.
//
// React-free and RN-free ON PURPOSE. mobile/lib/**/*.test.js runs under the
// repo's vitest in a Node environment, so anything imported here that pulled in
// react-native — or ./api, which reaches expo-constants and the supabase client
// — would take this file's own tests out of the glob. The screen does the IO;
// this file does the judging, and every branch below is pinned by shelly.test.js.
//
// Everything here is a MOBILE RE-TYPING of a decision the web surface already
// made, because mobile cannot import src/lib (CLAUDE.md, Web/mobile boundary).
// Each one names its web original so the pair can be moved together.

// ── Freshness thresholds ────────────────────────────────────────────────────
// Re-typed from src/lib/shelly/device-health.js (HEALTH_FRESH_MS /
// HEALTH_STALE_MS). The fresh window is the ENGINE'S WRITE FLOOR PLUS ONE
// MISSED SWEEP, not its read cadence: reconcile.js reads every adopted device
// once a minute but only writes a row — and only then does `last_seen_at`
// advance — when something moved, and an idle plug is deadband-stable by
// design, so its row is rewritten only on STATE_REFRESH_MS (5 min,
// src/lib/shelly/status.js). A shorter window flickers amber on healthy
// hardware for two minutes out of every five, which is exactly the noise that
// teaches an operator to ignore the chip.
//
// THESE NUMBERS AND THE WEB'S ARE ONE FACT, NOT TWO. Raise STATE_REFRESH_MS on
// the web and this file has to move with it in the same change, or the flicker
// this sizing exists to prevent comes back here instead.
export const PLUG_FRESH_MS = 5 * 60_000 + 60_000
export const PLUG_STALE_MS = 15 * 60_000

// The light-theme recipe from CLAUDE.md (text on a light card needs the -700
// ramp). Kept beside the grader for the same reason the web keeps
// HEALTH_TONE_CLASSES there: a new tone cannot be returned without something to
// render it in. The dot is a hex because it is a `style` backgroundColor on a
// plain <View>, not a class.
export const PLUG_TONE_TEXT = Object.freeze({
  green: 'text-emerald-700',
  amber: 'text-amber-700',
  red: 'text-red-700',
  grey: 'text-un1t-subtle',
})
export const PLUG_TONE_DOT = Object.freeze({
  green: '#10B981',
  amber: '#F59E0B',
  red: '#DC2626',
  grey: '#94A3B8',
})

const GREY = (label, reason) => ({ tone: 'grey', label, reason })

/**
 * How fresh is what the row is showing?
 *
 * Re-typed from `deviceHealth` in src/lib/shelly/device-health.js, INCLUDING
 * the order of the first two checks, neither of which is about the device:
 *
 *   1. `connected === false` WINS OVER EVERYTHING. After a deliberate
 *      Disconnect on the web the rows stay adopted (deleting them would cascade
 *      the energy history away), so `last_seen_at` simply stops advancing. A
 *      grader that started from staleness would paint every row red within a
 *      quarter of an hour and point the operator at a connection they removed
 *      on purpose. No connection means DORMANT, not broken.
 *
 *   2. `connected === null` NEVER REACHES RED. That is the third state
 *      GET /api/shelly/devices answers with (`connection_status: 'unknown'`)
 *      when the device list read fine and the connection row did not. Grading a
 *      live studio "Stale" off a database blip on OUR side would invent a fault
 *      in THEIR hardware, so the age still shows (it is a true fact about the
 *      last reading) but the verdict caps at amber. `undefined` is treated the
 *      same: a caller that has not resolved the flag yet must not get a
 *      confident answer either.
 *
 * @param {object} device   a shelly_devices row as GET /api/shelly/devices sends it
 * @param {boolean|null|undefined} connected  that response's `connected` flag
 * @param {number} [nowMs]  testable clock
 * @returns {{tone:'grey'|'green'|'amber'|'red', label:string, reason:string}}
 */
export function plugTone(device, connected, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()

  // (1) — before anything about the device itself.
  if (connected === false) return GREY('Not connected', 'not_connected')

  // (2) — uncertain connection: no red below, whatever the age says.
  const uncertain = connected === null || connected === undefined

  const seenMs = Date.parse(device?.last_seen_at ?? '')
  const hasSeen = Number.isFinite(seenMs)

  if (!hasSeen) {
    // With no reading AND no connection answer there is nothing to report but
    // the uncertainty itself — "waiting for its first status" would blame the
    // plug for a read that failed on our side.
    return uncertain
      ? GREY('Connection unknown', 'connection_unknown')
      : GREY('Waiting for first status', 'never_seen')
  }

  // A fact from the reading rather than an inference from a clock, so it
  // outranks the age below and stays grey — an offline plug is a normal
  // overnight state, not a fault.
  if (device?.last_state?.online === false) return GREY('Offline', 'offline')

  const ageMs = now - seenMs
  if (ageMs <= PLUG_FRESH_MS) return { tone: 'green', label: 'Online', reason: 'fresh' }

  // Never 0: an age of just over the fresh window rounds to 6, and anything
  // that rounded to "Last seen 0 min ago" would read as a bug.
  const mins = Math.max(1, Math.round(ageMs / 60_000))
  if (ageMs <= PLUG_STALE_MS) {
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging' }
  }
  if (uncertain) {
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging_unverified' }
  }
  return { tone: 'red', label: 'Stale — check the Shelly connection', reason: 'stale' }
}

/**
 * The relay as a sentence, with its wattage when there is one.
 *
 * TWO RULES FROM THE BACKEND, both re-typed rather than paraphrased:
 *
 *   • `last_state.output === null` IS "UNKNOWN", NEVER "OFF" (rule 1 of
 *     src/components/automations/ShellyDeviceCard.jsx). An offline plug reports
 *     nothing about its relay, and mig 562's column comment makes every writer
 *     write the full seven-field shape precisely so the null survives. Printing
 *     "Off" for it tells an operator a heater is safe when nobody knows.
 *
 *   • ABSENT IS NOT ZERO (status.js rule 1). `apower` is nulled deliberately
 *     after a manual switch — a set/switch measures nothing, so carrying the
 *     previous watts forward under a fresh timestamp would render a stale
 *     number as a live measurement. A non-number therefore renders no wattage
 *     at all rather than "0 W".
 *
 * @param {object} device
 * @returns {string} e.g. 'On · 42 W', 'Off', 'Unknown'
 */
export function plugStateLabel(device) {
  const state = device?.last_state || {}
  const word = state.output === true ? 'On' : state.output === false ? 'Off' : 'Unknown'
  if (!Number.isFinite(state.apower)) return word
  return `${word} · ${Math.round(state.apower)} W`
}

// OUR words for a command that has not landed yet, keyed by the toggle route's
// own `code`. Every entry starts with "Queued" because that is the fact: the
// override is written BEFORE the command is sent, and the cron applies a live
// override to every adopted device, enabled or not — so this is a delay, not a
// loss. The route's own `message` is preferred over these when it sent one (it
// is written against the exact failure it saw); these are the fallback, and
// they point at the web CRM because that is where the fixes live on mobile.
const QUEUED_COPY = Object.freeze({
  pending: 'Queued — the plug will follow when it is back online.',
  key_rejected: 'Queued — re-paste the Shelly key on the web CRM and the plug will follow.',
  rate_limited: 'Queued — Shelly is busy right now; the plug will follow within a minute.',
  bad_host: 'Queued — fix the Shelly server on the web CRM and the plug will follow.',
})

// An unmanaged device (`enabled:false` or `schedule_mode:'none'`) answers
// `holds_until_changed: true`: plan.js rule 2 returns before rule 4 can close
// anything, so an expired override is never undone and the relay stays exactly
// as set. That is the approved v1 behaviour, and a countdown rendered beside one
// would be a promise the engine never intended to keep — so the sentence says
// what actually happens instead of naming a time.
export const HOLDS_TEXT = 'Stays as set — no schedule runs this plug'

/**
 * Has the relay NOT moved yet?
 *
 * `pending: true` is the route's own flag. The second arm exists because
 * mobile's api() FLATTENS the one pending body that arrives with a non-2xx
 * status: a rate limit answers HTTP 429 with `success: true, pending: true` in
 * the body (the 429 is a back-off signal so the client stops re-pressing, not a
 * failure), and api()'s "non-2xx without our standard envelope" branch replaces
 * that body with `{ success:false, status, error:'HTTP 429' }`. Without this
 * arm mobile would tell an operator their switch failed when it is saved and
 * will apply within the minute.
 *
 * Read by FIELD, never by matching api()'s error string — that is the regex
 * coupling GEOFENCE-TRANSPORT.1 removed, and it stops matching the day someone
 * rewords the message. `transport` is excluded deliberately: api() tags its
 * OWN envelopes with it, so a 429 whose body could not even be parsed is an
 * unreadable answer, not a queued command.
 *
 * @param {object|null} json  an api() result for POST /api/shelly/devices/<id>/toggle
 */
export function isQueued(json) {
  if (!json) return false
  if (json.pending === true) return true
  return json.success === false && json.status === 429 && json.transport !== true
}

/**
 * The extra sentence a toggle answer deserves, or null when the plain
 * "Switched on." the caller composes says everything.
 *
 * Three outcomes:
 *   • queued (see isQueued)     → the route's own message, else QUEUED_COPY,
 *                                 plus the holds notice when it rides along.
 *   • plain success + holds     → the holds notice on its own.
 *   • a real failure, or a plain success with a schedule behind it → null.
 *     A failure is the CALLER's to render through errorText(), which reads the
 *     reassurance the routes deliberately fold into `error`.
 */
export function toggleResultText(json) {
  if (!json) return null
  if (isQueued(json)) {
    const code = json.pending === true ? (json.code || 'pending') : 'rate_limited'
    const queued = json.message || QUEUED_COPY[code] || QUEUED_COPY.pending
    return json.holds_until_changed ? `${queued} ${HOLDS_TEXT}` : queued
  }
  if (json.success === false) return null
  return json.holds_until_changed ? HOLDS_TEXT : null
}

/**
 * The sentence to show for a failed response body — the same chain the routes
 * were written against, re-typed from src/components/automations/shelly-fetch.js:
 *
 *   issues[0].message — validateBody's 400 shape puts the useful text here and
 *                       leaves `error` as the generic 'Invalid request'
 *   message           — a body that carried its reassurance there
 *   error             — every failure body; the routes deliberately fold their
 *                       reassurance INTO this string rather than parking it in
 *                       a `message` nobody reads
 */
export function errorText(json, fallback) {
  return json?.issues?.[0]?.message || json?.message || json?.error || fallback
}

/**
 * The name to show for a device that has none.
 *
 * Composed at render time, never stored: adopt writes `name` as the operator's
 * choice, then the Shelly account's, then NULL. A synthesised name on the row
 * would be indistinguishable from a human's the moment anyone looked at it.
 */
export function plugDisplayName(device) {
  return device?.name || `${device?.model || 'Shelly'} · ${String(device?.device_id || '').slice(-4)}`
}

// SHELLY-UI.6 — how fresh is what the card is showing?
//
// Pure and React-free so the page, a test and (later) any other surface grade
// a device the same way. Answers a tone, a sentence, and a machine-readable
// `reason` the card branches on (it disables the toggle strip on 'offline').
//
// THE ORDER OF THE FIRST TWO CHECKS IS THE WHOLE POINT, and neither is about
// the device:
//
//   1. `connected === false` WINS OVER EVERYTHING. After a deliberate
//      Disconnect the rows stay adopted (the connection route leaves them
//      alone on purpose — deleting them would cascade the energy history), so
//      `last_seen_at` simply stops advancing. A grader that started from
//      staleness would paint every card red "Stale — check the Shelly
//      connection" within a quarter of an hour and point the operator at a
//      connection they removed on purpose. No connection means DORMANT, not
//      broken.
//
//   2. `connected === null` NEVER REACHES RED. That is the third state
//      GET /api/shelly/devices answers with (`connection_status: 'unknown'`)
//      when the device list read fine and the connection row did not — the
//      payload exists precisely so the operator keeps their cards. Grading a
//      studio "Stale — check the Shelly connection" off a database blip on OUR
//      side would invent a fault in THEIR hardware, so the age still shows
//      (it is a true fact about the last reading) but the verdict caps at
//      amber. `undefined` is treated the same as null: a caller that has not
//      resolved the flag yet must not get a confident answer either.
//
// Everything below those is ordinary freshness — and the window is sized to
// the engine's WRITE floor, not to its READ cadence. SHELLY-UI.9b corrected
// this: reconcile.js reads every adopted device once a minute, but it only
// writes a row (and only then does `last_seen_at` advance) when stateChanged
// says something moved. A plug sitting idle is deadband-stable by design —
// same output, watts twitching in the third decimal — so its row is rewritten
// only on the STATE_REFRESH_MS floor, once every five minutes. A three-minute
// green window therefore went amber on every healthy idle plug for two
// minutes out of every five: a flicker with no fault behind it, and the exact
// noise that teaches an operator to ignore the chip.
//
// So the fresh window is the write floor PLUS one sweep of slack — a plug that
// has missed its own refresh deadline by a whole tick is the first moment
// there is anything to say. Imported rather than re-typed, because the two
// numbers are one fact: raise STATE_REFRESH_MS and this window has to move
// with it or the flicker comes straight back.
import { STATE_REFRESH_MS } from '@/lib/shelly/status'

// The engine's own refresh floor, plus one missed sweep.
export const HEALTH_FRESH_MS = STATE_REFRESH_MS + 60_000
// Past this, "the cron just hasn't ticked" stops being plausible — three
// missed refresh floors, not three missed reads.
export const HEALTH_STALE_MS = 15 * 60_000

const GREY = (label, reason) => ({ tone: 'grey', label, reason })

/**
 * @param {object} device        a shelly_devices row (DEVICE_COLUMNS shape)
 * @param {object} opts
 * @param {boolean|null|undefined} opts.connected  the location's connection
 *   flag as GET /api/shelly/devices reports it: true, false, or null/undefined
 *   for "we could not read it".
 * @param {number} [opts.nowMs]  testable clock
 * @returns {{tone:'grey'|'green'|'amber'|'red', label:string, reason:string}}
 */
export function deviceHealth(device, { connected, nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()

  // (1) — before anything about the device itself.
  if (connected === false) return GREY('Not connected', 'not_connected')

  // (2) — uncertain connection: no red below, whatever the age says.
  const uncertain = connected === null || connected === undefined

  const seenMs = Date.parse(device?.last_seen_at ?? '')
  const hasSeen = Number.isFinite(seenMs)

  if (!hasSeen) {
    // With no reading AND no connection answer there is nothing to report but
    // the uncertainty itself — saying "waiting for its first status" would
    // blame the plug for a read that failed on our side.
    return uncertain
      ? GREY('Connection unknown', 'connection_unknown')
      : GREY('Waiting for first status', 'never_seen')
  }

  // The device answered and said it is not reachable — a fact from the
  // reading, not an inference from a clock, so it outranks the age below and
  // stays grey (an offline plug is a normal overnight state, not a fault).
  if (device?.last_state?.online === false) return GREY('Offline', 'offline')

  const ageMs = now - seenMs
  if (ageMs <= HEALTH_FRESH_MS) return { tone: 'green', label: 'Online', reason: 'fresh' }

  // Never 0: an age of just over the fresh window rounds to 6, and anything
  // that rounded to "Last seen 0 min ago" would read as a bug.
  const mins = Math.max(1, Math.round(ageMs / 60_000))
  if (ageMs <= HEALTH_STALE_MS) {
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging' }
  }
  if (uncertain) {
    // The age is real and worth showing; the CONCLUSION is not ours to draw
    // while we cannot see the connection. Capped at amber — see (2).
    return { tone: 'amber', label: `Last seen ${mins} min ago`, reason: 'lagging_unverified' }
  }
  return { tone: 'red', label: 'Stale — check the Shelly connection', reason: 'stale' }
}

// The light-theme chip recipe (CLAUDE.md: bg-<c>-500/10 text-<c>-700). Kept
// beside the grader so a new tone cannot be returned without a class to
// render it in.
export const HEALTH_TONE_CLASSES = Object.freeze({
  green: 'bg-emerald-500/10 text-emerald-700',
  amber: 'bg-amber-500/10 text-amber-700',
  red: 'bg-red-500/10 text-red-700',
  grey: 'bg-un1t-muted/10 text-un1t-subtle',
})

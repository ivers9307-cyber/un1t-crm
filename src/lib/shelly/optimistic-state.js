// The optimistic last_state a route writes after a command it KNOWS landed.
// Moved out of the device toggle route (SHELLY-UI.5) when the group switch
// (SHELLYGROUPS.5) needed the same rule for each member it stamps: two copies
// is how a group press and a device press would come to paint a relay
// differently.

import { stateFromReading } from './status'

// The seven fields mig 562's column comment requires of every last_state
// writer. A partial shape is what makes `output` read as "off" when it is
// really "unknown", so a row that is missing any of them is rebuilt rather
// than spread.
const STATE_KEYS = ['online', 'output', 'apower', 'aenergy_wh', 'temperature_c', 'source', 'at']
const hasFullState = (s) =>
  !!s && typeof s === 'object' && !Array.isArray(s) && STATE_KEYS.every((k) => k in s)

/**
 * The optimistic last_state after a command we KNOW landed.
 *
 * Only the three fields we have evidence for are asserted — output, source and
 * `at` — plus `online`, which rests on exactly the same evidence as the
 * `last_seen_at` written beside it: Shelly Cloud answers a set/switch for an
 * unreachable device with a body-level error, which client.js tags
 * `kind:'device'`, so an ok result means the plug spoke. If that ever proves
 * wrong, this line and the last_seen_at stamp must change together.
 *
 * THE MEASUREMENTS GO TO NULL (SHELLY-UI.9b). A set/switch measures nothing:
 * it returns no watts, no energy counter and no temperature. Carrying the
 * PREVIOUS readings forward under a FRESH `at` is not a neutral act — `at` is
 * what the card reads as "how current is this number", so the old wattage
 * would be re-dated to this instant and rendered as a live measurement of a
 * relay whose state we just changed. Switching a heater ON and then showing
 * the 0 W it drew while off, timestamped "just now", is precisely the silent
 * wrong value this file's write order exists to avoid. Null renders as "—"
 * and the next cron read fills it within the minute. (status.js rule 1:
 * absent is not zero — and it is not a stale number wearing a new date
 * either.)
 */
export function optimisticState(prev, channel, on, nowIso, kind = 'switch') {
  const base = hasFullState(prev)
    ? { ...prev }
    : stateFromReading(null, { online: true, channels: [] }, channel, nowIso, kind)
  return {
    ...base,
    // SHELLYLIGHT.3 — a light's level is a SETTING, not a measurement: set/light
    // sends `on` only and the dimmer keeps its own brightness, so the last known
    // level is still the truth. A switch never carries the key (status.js).
    ...(kind === 'light' ? { brightness: base.brightness ?? null } : {}),
    online: true,
    output: on,
    apower: null,
    aenergy_wh: null,
    temperature_c: null,
    source: 'manual',
    at: nowIso,
  }
}

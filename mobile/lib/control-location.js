// mobile/lib/control-location.js
//
// HOME-LOC.3 — the ONE place that decides which studio a device-control
// screen commands, and which locations its pill's picker may offer.
//
//   controlLocation = explicit override (this visit's ?loc= param)
//                  ?? physical location (when at_studio)
//                  ?? activeLocation
//
// The override must be one of the caller's own locations — a hand-typed
// deep-link id outside the assignment list is ignored, not honoured (the
// server would 403 it anyway; this keeps the pill honest too).
// Pure module — no native imports; permissions.js is already Node-safe.
//
// `source` ('manual' | 'detected') feeds the pill's label, and the pill AND
// the command it sends must both derive from THIS same resolved value —
// never re-resolve independently, or the label and the actual command
// target can silently disagree (spec §5).
//
// Permission is deliberately NOT checked in here — this function only
// answers "which location", not "is this user allowed to control it". The
// screen's own `allowed` gate (canMobile, via pickerLocations below) owns
// that check.

import { canMobile } from './permissions'

/**
 * @param {string|null} overrideId  This visit's ?loc= route param. Screens
 *   must coerce useLocalSearchParams' `string | string[] | undefined` to
 *   string-or-null before calling — a non-string (e.g. the string[] you get
 *   from a repeated query param) fails safe here: it can never strictly
 *   equal a location id, so it just falls through to the next tier instead
 *   of resolving to a bogus location.
 * @param {{status: string, location: object|null}} physical  From resolvePhysicalLocation (Task 2).
 * @param {object|null|undefined} activeLocation
 * @param {object[]|undefined} locations  The caller's own assigned locations.
 */
export function resolveControlLocation({ overrideId, physical, activeLocation, locations }) {
  if (overrideId) {
    const loc = (locations || []).find((l) => l.id === overrideId)
    if (loc) return { location: loc, source: 'manual' }
  }
  if (physical?.status === 'at_studio' && physical.location) {
    return { location: physical.location, source: 'detected' }
  }
  return { location: activeLocation || null, source: 'manual' }
}

/**
 * Locations this user may pick in a control screen's pill, by that screen's
 * perm key. `permKey` must be a known permission key (one of
 * MOBILE_PERMISSION_KEYS / CROSS_PLATFORM_KEYS in shared/permissions.js) —
 * an unmapped key silently resolves to true for master (which clears the
 * tier-1 feature gate for an unmapped key, then short-circuits) and false
 * for everyone else via the tier-3 role default — reading as "no locations
 * available" rather than as a broken key.
 *
 * No `!profile` guard needed — canMobile already returns false for a falsy
 * profile at every location, so the filter naturally empties.
 */
export function pickerLocations(profile, locations, permKey) {
  return (locations || []).filter((l) => canMobile(profile, permKey, l))
}

/**
 * Whether the pill's picker has anything worth offering. `pickable.length >
 * 1` alone strands the exact user the pill exists for: a coach who holds
 * the screen's perm key at exactly ONE studio, when the resolved location
 * (detected or fallback) is a DIFFERENT one — `pickable` is length 1, the
 * naive rule reads "nothing to pick", and the tap goes dead. The fix is to
 * also open the picker when that single pickable location differs from the
 * one currently in force, so the coach can still swap onto the studio
 * they're actually permitted to control (HOME-LOC.6b).
 */
export function canPickLocation(pickable, currentId) {
  return pickable.length > 1 || (pickable.length === 1 && pickable[0].id !== currentId)
}

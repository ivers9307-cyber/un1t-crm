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

import { canMobile } from './permissions'

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

/** Locations this user may pick in a control screen's pill, by that screen's perm key. */
export function pickerLocations(profile, locations, permKey) {
  if (!profile) return []
  return (locations || []).filter((l) => canMobile(profile, permKey, l))
}

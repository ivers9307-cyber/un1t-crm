// src/lib/geofence-permission-chips.js
//
// GEO-ATT.22 — the ONE definition of how a device's background-location
// permission is labelled and coloured for operators.
//
// It was written out three times: StaffDevicesCard, StaffSearchableList and the
// notifications health page each carried their own copy of the value→label map,
// and two of them carried their own copy of the tone→classes map as well. Three
// copies of a lookup is a countdown: GEO-ATT.21 added a fifth value ('unknown')
// and had to edit all three, and a miss would have rendered a blank "—" on that
// surface — for the exact fault state the value exists to make VISIBLE. Worse
// than the bug it was added to expose.
//
// The registry is only half of it. `geofence-permission-chips.test.js` reads the
// CHECK constraint out of supabase/migrations and fails when this list and the
// database disagree IN EITHER DIRECTION, so a future migration that adds a
// value cannot quietly ship a surface that can't render it. Same shape as
// merge-tags.js / merge-tags.test.js scanning postmark.js.

/**
 * Every value `device_tokens.geofence_permission` may hold, NOT counting NULL.
 * Kept in step with the CHECK constraint by the test above. The API's Zod enum
 * reads this so a route can't accept a value the UI cannot draw.
 */
export const GEOFENCE_PERMISSION_VALUES = [
  'always',
  'when_in_use',
  'denied',
  'undetermined',
  'unknown',
]

/**
 * Light-theme chip classes. The -700 text ramp is the repo's chip-contrast rule
 * (a -300/-400 ramp is unreadable on the light cards these render on, and
 * `check:guardrails` enforces it at the call sites).
 */
export const CHIP_TONE_CLASSES = {
  green: 'bg-emerald-500/10 text-emerald-700',
  amber: 'bg-amber-500/10 text-amber-700',
  red: 'bg-red-500/10 text-red-700',
  neutral: 'bg-gray-500/10 text-gray-700',
}

/**
 * value → { tone, label }.
 *
 * 'unknown' is RED, not neutral: the device told us its permission API failed,
 * so geofencing is not running on that handset and nobody is being clocked in
 * by it. That is a fault to chase, and colouring it like "Not asked" would bury
 * it. NULL has no entry on purpose — see geofencePermissionChip below.
 */
export const GEOFENCE_PERMISSION_CHIPS = {
  always: { tone: 'green', label: 'Always' },
  when_in_use: { tone: 'amber', label: 'While using' },
  denied: { tone: 'red', label: 'Denied' },
  undetermined: { tone: 'neutral', label: 'Not asked' },
  unknown: { tone: 'red', label: 'Unavailable' },
}

/**
 * Resolve a stored value to what a chip needs, or null when there is nothing to
 * draw. NULL/absent means the device has NEVER reported (an old client, or one
 * that hasn't foregrounded since STAFF-DEV.7) and every surface renders it as
 * "—", never as a denial: absence of data is not a denial, and keeping those
 * apart is the whole diagnostic value.
 *
 * @param {string|null|undefined} value
 * @returns {{ tone: string, label: string, className: string }|null}
 */
export function geofencePermissionChip(value) {
  const entry = GEOFENCE_PERMISSION_CHIPS[value]
  if (!entry) return null
  return { tone: entry.tone, label: entry.label, className: CHIP_TONE_CLASSES[entry.tone] }
}

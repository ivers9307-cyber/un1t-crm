// mobile/lib/widget-tokens.js
// WIDGET.1 (Phase 2, Task 5) — pure decisions behind the widget mint/revoke
// screen (mobile/app/(staff)/settings/widgets.jsx). No React Native imports
// here — there is no RN component test runner in this repo, so every
// decision the screen makes lives here where vitest can reach it, and the
// screen stays a thin renderer around these functions.

import { canMobile } from './permissions'

// The server's own device_label schema (src/app/api/widget/tokens/route.js:
// z.string().trim().min(1).max(60).optional()) — kept in sync by hand since
// mobile/ cannot import the web's zod schema (see check:mobile-imports).
const DEVICE_LABEL_MAX = 60

/**
 * Whether `profile` may mint/hold a widget credential at `location`.
 *
 * A placed widget can show doors + AC (gated server-side by
 * `studio_management`, via /api/widget/devices) OR Sonos + Shelly (gated by
 * `device_control`) — see that route's own header comment on why it reuses
 * those two decisions rather than inventing a new gate. Either key is
 * therefore enough to make a widget worth having at this studio; requiring
 * both would deny it to someone who, say, only ever unlocks doors.
 *
 * Mirrors the Studio hub's own composite gate
 * (mobile/app/(staff)/(tabs)/studio.jsx: `!canStudio && !canTv && ...`)
 * rather than inventing a third permission key that could drift from the
 * server's own two.
 */
export function canManageWidgets(profile, location) {
  if (!profile || !location) return false
  return (
    canMobile(profile, 'studio_management', location) ||
    canMobile(profile, 'device_control', location)
  )
}

/**
 * The studios this staff member may mint a widget credential for — every
 * assigned location where canManageWidgets is true. A staff member who
 * works multiple studios mints once per studio (see the screen's header
 * comment), so this drives both the LocationPill's picker and, on the
 * widget's own config sheet, which studios are worth offering.
 *
 * control-location.js's pickerLocations() takes a single permKey and can't
 * express this OR, so this is a distinct function rather than a call to it.
 */
export function widgetEligibleLocations(profile, locations) {
  return (locations || []).filter((l) => canManageWidgets(profile, l))
}

/**
 * A sane default device label from the device's own name (expo-device's
 * Device.deviceName, read by the screen — this function only cleans it up).
 * Never returns whitespace-only or overlong text: the server's zod schema
 * treats `device_label` as optional but, if PRESENT, requires min(1) — an
 * empty/blank string would fail validation instead of just being omitted,
 * and a name past its 60-char max would fail too. The screen sends
 * `undefined` (not this function's job) when the result is ''.
 */
export function defaultDeviceLabel(rawDeviceName) {
  const trimmed = (rawDeviceName || '').trim()
  return trimmed.slice(0, DEVICE_LABEL_MAX)
}

/**
 * Which of the caller's stored credentials (if any) belongs to `locationId`
 * — the mint-vs-re-mint decision. storeWidgetCredential (widget-bridge.js)
 * already dedups the App Group array by locationId, so the screen's own job
 * is just "is there one to show/replace here", not merging.
 */
export function findStoredCredential(storedStudios, locationId) {
  if (!locationId) return null
  return (storedStudios || []).find((s) => s.locationId === locationId) || null
}

/**
 * Reconcile the server's live widget-token list against what's stored
 * locally in the App Group (widget-bridge.js's listStoredStudios()).
 *
 * The two CAN disagree: revoking a credential from the CRM staff page kills
 * it server-side (DELETE /api/widget/tokens/:id stamps revoked_at), but the
 * phone's App Group still holds the plaintext token until something
 * reconciles — until then the widget would keep trying a token the server
 * will keep refusing.
 *
 * Matched by tokenId, not locationId: GET /api/widget/tokens deliberately
 * never returns location_id in its response shape (only id, device_label,
 * created_at, last_used_at — see that route's own comment on why token_hash
 * and location scoping are kept off the wire), so tokenId is the only key
 * the server's list and the App Group's rows share. A stored credential
 * whose tokenId is no longer among the server's live ids is stale, full
 * stop, regardless of which studio it names.
 *
 * @param {{id: string}[]} serverTokens        GET /api/widget/tokens' live list
 * @param {import('./widget-bridge').StoredStudioCredential[]} storedStudios  listStoredStudios()
 * @returns {{live: object[], stale: object[]}}
 */
export function reconcileStoredWidgets(serverTokens, storedStudios) {
  const liveIds = new Set((serverTokens || []).map((t) => t.id))
  const stored = storedStudios || []
  return {
    live: stored.filter((s) => liveIds.has(s.tokenId)),
    stale: stored.filter((s) => !liveIds.has(s.tokenId)),
  }
}

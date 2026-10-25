// mobile/lib/widget-bridge.js
// WIDGET.1 — the App Group bridge between the RN app and the widget
// extension. Wraps @bacons/apple-targets's ExtensionStorage rather than
// hand-rolling a native module — the package already ships exactly this
// (NSUserDefaults(suiteName:) under the hood on both sides), documented at
// https://github.com/EvanBacon/expo-apple-targets (packages/apple-targets/README.md).
//
// A device may hold widgets for MORE than one studio (a staff member who
// works two locations), so the store is a small array keyed by location_id
// under ONE key, not one key per studio — the widget's studio-picker
// AppIntent (StudioEntity.swift) reads this same array to populate its
// choices, entirely offline: picking a studio in the widget's config sheet
// never makes a network call, only minting a NEW credential does.
//
// MUST stay in the App Group the widget extension actually reads —
// mobile/app.config.js's ios.entitlements declares the same string, and
// mobile/targets/widgets/expo-target.config.js inherits it automatically
// (see the Task 15 spike notes). If you ever rename this, rename the
// entitlement in app.config.js in the SAME commit.

import Constants from 'expo-constants'
import { ExtensionStorage } from '@bacons/apple-targets'

// 🔴 Resolved at RUNTIME from the manifest, never hard-coded. The legacy
// build (LEGACY_APP=1) carries `group.com.un1tdublin.crm.widgets`, and
// process.env.LEGACY_APP is a BUILD-time variable that does not exist in the
// RN runtime — only EXPO_PUBLIC_* is inlined. A hard-coded id would make the
// bridge open a group the legacy app does not hold, so the widget would
// silently do nothing for exactly the installed base the two-build rule
// exists to protect. expo-constants carries the resolved ios.entitlements
// through into the manifest, which is why this reads from there.
const GROUPS_KEY = 'com.apple.security.application-groups'
export const APP_GROUP =
  Constants?.expoConfig?.ios?.entitlements?.[GROUPS_KEY]?.[0]
  // Fall back to the public id rather than throwing: a missing manifest entry
  // is a build-config bug, and a widget that quietly does nothing is a better
  // failure than an app that will not start.
  || 'group.ie.repset.widgets'
const STUDIOS_KEY = 'repset_widget_studios'

const storage = new ExtensionStorage(APP_GROUP)

/**
 * @typedef {object} StoredStudioCredential
 * @property {string} locationId
 * @property {string} locationName   - for the config-sheet label; never re-fetched by the extension
 * @property {string} tokenId        - the widget_tokens.id, for display/troubleshooting only
 * @property {string} token          - the plaintext rwt_ token, the ONLY copy outside the server's hash
 */

/** @returns {StoredStudioCredential[]} */
export function listStoredStudios() {
  const raw = storage.get(STUDIOS_KEY)
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** @param {StoredStudioCredential} cred */
export function storeWidgetCredential(cred) {
  const rest = listStoredStudios().filter((s) => s.locationId !== cred.locationId)
  storage.set(STUDIOS_KEY, JSON.stringify([...rest, cred]))
}

/** @param {string} locationId */
export function removeWidgetCredential(locationId) {
  const rest = listStoredStudios().filter((s) => s.locationId !== locationId)
  storage.set(STUDIOS_KEY, JSON.stringify(rest))
}

/**
 * Ask every placed widget to refresh its timeline now. Called from:
 *   - the mint/revoke screen (Task 5), right after a credential changes,
 *   - the push-received handler (Task 13), as a best-effort nudge.
 * ExtensionStorage.reloadWidget() throws in an environment with no native
 * module (Expo Go, a stale dev client pre-prebuild) — this must never take
 * down whatever called it for that reason.
 */
export function reloadWidgets() {
  try {
    ExtensionStorage.reloadWidget()
  } catch {
    // best-effort — see the comment above.
  }
}

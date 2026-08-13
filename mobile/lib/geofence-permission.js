// mobile/lib/geofence-permission.js
// The single answer to "what is this device's geofence permission, and what
// follows from it". NO native imports — vitest runs this in Node.
//
// GEO-ATT.21 — before this, two callers asked `Location.getBackgroundPermissions
// Async()` and disagreed about what an ERROR meant:
//
//   LocationGate.check()  catch { setGranted(true)  }  → gate hidden
//   geofence.syncGeofences catch { granted = false }  → stopGeofencingAsync()
//
// Each is defensible alone. Together they are the worst of both: the
// registration is torn down, so the staffer is never clocked in, while the app
// says nothing is wrong. And the gate's reporting block bailed out on the same
// error (`if (!bg) return`), so the CRM kept the last good value and no
// operator surface could show the fault. Silent, and invisible from both ends.
//
// The trigger is a throw from the native module, which in practice means
// `ExpoLocation` is missing from the binary — a JS bundle that reached a
// pre-expo-location build. That is exactly what runtimeVersion '2.2.0' exists
// to prevent, so this should not happen; the guard is a human remembering to
// bump a string on the next native change. This module makes the failure
// survivable and VISIBLE rather than betting on that.
//
// Both fail directions are now declared here, once, and tested:
//   blocks:false      an unreadable permission must never lock staff out of
//                     the whole app (the original, deliberate call — kept).
//   mayRegister:false we cannot claim a permission we could not read.
//   value:'unknown'   a real, storable value, so the CRM shows the fault
//                     instead of a stale "always".

/**
 * @param {{ bg?: {status?: string, canAskAgain?: boolean}|null,
 *           fg?: {status?: string, canAskAgain?: boolean}|null,
 *           error?: unknown }} input
 * @returns {{ value: 'always'|'when_in_use'|'denied'|'undetermined'|'unknown',
 *             blocks: boolean, mayRegister: boolean, sendToSettings: boolean }}
 */
export function resolveGeofencePermission({ bg, fg, error } = {}) {
  // No reading — whether it threw or came back empty, we do not know.
  if (error || !bg) {
    return { value: 'unknown', blocks: false, mayRegister: false, sendToSettings: false }
  }
  if (bg.status === 'granted') {
    return { value: 'always', blocks: false, mayRegister: true, sendToSettings: false }
  }
  // Value mapping is STAFF-DEV.7's, preserved exactly — changing it would
  // silently reclassify every device already in the CRM. Background-first by
  // design: the column answers "can geofence attendance actually fire on this
  // phone?", so a background denial is 'denied' even when the foreground is
  // granted (that is the iOS "While Using" shape). 'when_in_use' is therefore
  // mainly an Android shape: background undetermined, foreground granted.
  if (bg.status === 'denied') {
    return {
      value: 'denied',
      blocks: true,
      mayRegister: false,
      sendToSettings: bg.canAskAgain === false,
    }
  }
  const value = fg?.status === 'granted' ? 'when_in_use' : 'undetermined'
  return { value, blocks: true, mayRegister: false, sendToSettings: false }
}

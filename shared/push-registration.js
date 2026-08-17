// Pure push-registration decision helpers — shared web↔mobile seam so the
// launch-time registration logic in mobile/app/(tabs)/_layout.jsx is unit
// testable without an Expo/native runtime.
//
// Two decisions live here:
//   shouldRegisterPush(...)  — should we attempt registration this launch?
//   isGenuinePushSuccess(...) — did an attempt actually register a token
//                               server-side (so we can latch and stop retrying)?

// Decide whether to attempt registering for push at launch.
//
//   optedOut    — member turned push OFF (persisted flag). Honour it: skip.
//   permission  — current OS permission status ('granted' | 'denied' |
//                 'undetermined' | ...). Only 'granted' is worth attempting;
//                 anything else means getExpoPushTokenAsync would no-op/throw.
//   lastResult  — the result of the previous registerForPushNotifications()
//                 call this launch (or null on first attempt). If it already
//                 genuinely succeeded, don't attempt again.
export function shouldRegisterPush({ optedOut, permission, lastResult } = {}) {
  if (optedOut) return false
  if (permission !== 'granted') return false
  if (isGenuinePushSuccess(lastResult)) return false
  return true
}

// A registration attempt only counts as success — and should latch, so we stop
// retrying — when a token was obtained AND the server POST did not fail.
//
// registerForPushNotifications() returns one of:
//   { skipped: true, reason }                    — not a success (simulator,
//                                                   permission_denied, token_error, no_token)
//   { token, result }  where result is the api() return:
//     - { success: false, error } on a failed POST → NOT a success (retry next launch)
//     - anything else (e.g. { success: true } / { ok: true }) → success
export function isGenuinePushSuccess(result) {
  if (!result || typeof result !== 'object') return false
  if (result.skipped) return false
  if (!result.token) return false
  // A failed server POST surfaces as result.result.success === false.
  if (result.result && result.result.success === false) return false
  return true
}

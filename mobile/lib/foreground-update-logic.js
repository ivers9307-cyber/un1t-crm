// Pure decision logic for the foreground OTA update check. NO native
// imports — vitest runs this in Node (see vitest.config.js include glob).
// The RN/expo-updates wiring lives in foreground-ota.jsx; this module only
// answers "should we check / reload / defer right now?" so the throttle and
// safety rules are unit-testable.
//
// Rules encoded here:
//   - Only a REAL foreground (background→active) counts. inactive→active is
//     a control-centre / app-switcher flicker on iOS and must never trigger
//     a check or yank the UI with a reload.
//   - Checks are throttled to one per CHECK_THROTTLE_MS.
//   - A fetched update reloads immediately only when the fetch lands within
//     RELOAD_GRACE_MS of the foreground transition AND no text input is
//     focused — otherwise the user is mid-task and the reload is deferred
//     to the next background→active transition.

export const CHECK_THROTTLE_MS = 15 * 60 * 1000
export const RELOAD_GRACE_MS = 10 * 1000

export function createUpdateGate({
  throttleMs = CHECK_THROTTLE_MS,
  graceMs = RELOAD_GRACE_MS,
} = {}) {
  let lastCheckAt = null
  let foregroundedAt = null
  let pendingReload = false

  return {
    // AppState transition → 'reload' (a deferred update is waiting),
    // 'check' (throttle window elapsed), or 'none'.
    onAppStateChange(prevState, nextState, now) {
      if (prevState !== 'background' || nextState !== 'active') return 'none'
      foregroundedAt = now
      if (pendingReload) return 'reload'
      if (lastCheckAt !== null && now - lastCheckAt < throttleMs) return 'none'
      lastCheckAt = now
      return 'check'
    },

    // A fetched update is ready → 'reload' (safe to apply now) or 'defer'
    // (apply on the next background→active transition).
    onUpdateFetched(now, { inputFocused = false } = {}) {
      const inGrace =
        foregroundedAt !== null && now - foregroundedAt <= graceMs
      if (inGrace && !inputFocused) return 'reload'
      pendingReload = true
      return 'defer'
    },
  }
}

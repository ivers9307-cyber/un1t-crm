// mobile/lib/studio-pin-lock-logic.js
// Pure logic for the studio-device PIN idle lock. NO native imports —
// vitest runs this in Node. Mirrors biometric-lock-logic.js.

export const STUDIO_IDLE_MS = 5 * 60 * 1000 // 5 minutes — matches the web kiosk

// Lock the device back to the PIN pad once it's gone idle (no touches)
// for the timeout. lastActivityAt == null means "never active yet" →
// not idle (the app just opened / just unlocked).
export function shouldLockForIdle(lastActivityAt, now, idleMs = STUDIO_IDLE_MS) {
  if (lastActivityAt == null) return false
  return now - lastActivityAt >= idleMs
}

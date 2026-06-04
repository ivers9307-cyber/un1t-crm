// Pure logic for the biometric app-lock. NO native imports — vitest runs this
// in Node. The expo-local-authentication AuthenticationType enum is inlined
// (stable contract: FINGERPRINT = 1, FACIAL_RECOGNITION = 2, IRIS = 3).
const FINGERPRINT = 1
const FACIAL_RECOGNITION = 2

export const RELOCK_GRACE_MS = 5 * 60 * 1000

// Re-lock if the app was backgrounded and the grace window has elapsed.
export function shouldRelock(lastBackgroundedAt, now, graceMs = RELOCK_GRACE_MS) {
  if (lastBackgroundedAt == null) return false
  return now - lastBackgroundedAt >= graceMs
}

// Human label for the enrolled biometric. Face ID wins over Touch ID; iris /
// none → generic "biometrics".
export function biometricLabel(types) {
  const t = Array.isArray(types) ? types : []
  if (t.includes(FACIAL_RECOGNITION)) return 'Face ID'
  if (t.includes(FINGERPRINT)) return 'Touch ID'
  return 'biometrics'
}

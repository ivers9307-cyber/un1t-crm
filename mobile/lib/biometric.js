// Thin wrappers over expo-local-authentication + the secure-store prefs for the
// biometric app-lock. The native module is only present in a native build —
// these run a safe fallback if the bridge is missing, so the JS never hard-
// crashes (the capability check returns unavailable).
import * as LocalAuthentication from 'expo-local-authentication'
import * as SecureStore from 'expo-secure-store'

const ENABLED_KEY = 'biometric_lock_enabled'
const ASKED_KEY = 'biometric_prompt_asked'

// { available, types } — available only when hardware exists AND a biometric is
// enrolled. types is the AuthenticationType[] for labelling.
export async function getBiometricCapability() {
  try {
    const [hasHardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ])
    return { available: !!hasHardware && !!enrolled, types: types || [] }
  } catch {
    return { available: false, types: [] }
  }
}

// Run the biometric prompt. Passcode fallback is on by default (we pass a
// fallbackLabel and do NOT set disableDeviceFallback). Returns { success }.
export async function runBiometricAuth(promptMessage) {
  try {
    const res = await LocalAuthentication.authenticateAsync({ promptMessage, fallbackLabel: 'Use passcode' })
    return { success: !!res?.success, error: res?.error }
  } catch (e) {
    return { success: false, error: e?.message || 'auth_failed' }
  }
}

export async function isLockEnabled() {
  try { return (await SecureStore.getItemAsync(ENABLED_KEY)) === '1' } catch { return false }
}
export async function setLockEnabledPref(on) {
  try { await SecureStore.setItemAsync(ENABLED_KEY, on ? '1' : '0') } catch { /* best-effort */ }
}
export async function wasPromptAsked() {
  try { return (await SecureStore.getItemAsync(ASKED_KEY)) === '1' } catch { return false }
}
export async function markPromptAsked() {
  try { await SecureStore.setItemAsync(ASKED_KEY, '1') } catch { /* best-effort */ }
}

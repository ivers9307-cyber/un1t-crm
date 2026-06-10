# Mobile Face ID / Touch ID App-Lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in biometric app-lock — Face ID / Touch ID required to reveal CF Studio on cold launch and after ≥ 5 minutes backgrounded.

**Architecture:** A `BiometricLockProvider` (inside `AuthProvider`) wraps the Stack and renders an absolute `LockScreen` overlay when locked — never remounting the navigation tree (per the root-layout race warning). Pure timing/label logic is isolated for unit tests; the native bridge (`expo-local-authentication`) lives in a thin wrapper.

**Tech Stack:** Expo SDK 54, `expo-local-authentication` (new native module), `expo-secure-store` (already in), `AppState`, NativeWind, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-faceid-applock-design.md` · **Branch:** `mobile-faceid-applock`.

---

## 🚨 Read first: this is a NATIVE release, and the OTA pipeline is a landmine here

`expo-local-authentication` is a **native module**. The repo auto-publishes an OTA to the production channel on every merge to `main` that touches `mobile/**` (`eas-update.yml`). **An OTA carrying this code would crash every existing install** — the old binaries don't contain the native module, so `import … 'expo-local-authentication'` throws at launch. The same class as the recent `MANAGER_ROLES` crash, but worse (all installs).

So the ship task (Task 7) **builds the code + opens the PR but does NOT merge**, and stops to let the user drive the native-release sequence (build + distribute the new binary, isolate the OTA lane, then merge). Do not merge to `main` as a reflex.

---

## Verified contracts

```
expo-secure-store (mirror mobile/lib/impersonate.js):
  SecureStore.getItemAsync(KEY) / setItemAsync(KEY, val) / deleteItemAsync(KEY), each in try/catch.

expo-local-authentication:
  hasHardwareAsync(): Promise<boolean>
  isEnrolledAsync(): Promise<boolean>
  supportedAuthenticationTypesAsync(): Promise<number[]>   // AuthenticationType: FINGERPRINT=1, FACIAL_RECOGNITION=2, IRIS=3
  authenticateAsync({ promptMessage, fallbackLabel?, cancelLabel?, disableDeviceFallback? }): Promise<{ success, error?, warning? }>
  Config plugin: ['expo-local-authentication', { faceIDPermission: '...' }]  → writes NSFaceIDUsageDescription.

app.config.js: plugins array = ['expo-router','expo-secure-store','expo-font',['expo-notifications',{…}]]; version '1.2.1'.
```

---

## File Structure

| File | Responsibility |
|---|---|
| `mobile/lib/biometric-lock-logic.js` + `.test.js` | **new** — pure `shouldRelock`, `biometricLabel`, `RELOCK_GRACE_MS` (no native imports → vitest-safe) |
| `mobile/lib/biometric.js` | **new** — `getBiometricCapability`, `runBiometricAuth`, secure-store pref helpers (native imports) |
| `mobile/lib/biometric-lock.jsx` | **new** — `BiometricLockProvider` + `useBiometricLock` + enable-prompt, renders `LockScreen` |
| `mobile/components/LockScreen.jsx` | **new** — absolute lock overlay (unlock + Sign out escape) |
| `mobile/app/_layout.jsx` | wrap the Stack with `BiometricLockProvider` |
| `mobile/app/(tabs)/more.jsx` | add the Face ID `Switch` toggle row |
| `mobile/app.config.js` | add the plugin + bump version → `1.3.0` |
| `mobile/package.json` + `package-lock.json` | `expo-local-authentication` (via `expo install`) |

---

## Task 1: Native enablement (install + plugin + version)

**Files:** Modify `mobile/app.config.js`, `mobile/package.json` (+ lock via expo install)

- [ ] **Step 1: Install the native module** (updates `package.json` AND `package-lock.json` together)

```bash
cd mobile && npx expo install expo-local-authentication && cd ..
```
Expected: `expo-local-authentication` appears in `mobile/package.json` dependencies; `mobile/package-lock.json` updated.

- [ ] **Step 2: Add the config plugin** — in `mobile/app.config.js`, replace the end of the `plugins` array:

```js
    [
      'expo-notifications',
      {
        // Android notification tray icon — must be a white silhouette
        // on transparent (Android masks it). iOS uses the app icon.
        icon: './assets/notification-icon.png',
        color: '#111827',
      },
    ],
  ],
```

with:

```js
    [
      'expo-notifications',
      {
        // Android notification tray icon — must be a white silhouette
        // on transparent (Android masks it). iOS uses the app icon.
        icon: './assets/notification-icon.png',
        color: '#111827',
      },
    ],
    // FACE-ID — biometric app-lock. faceIDPermission writes
    // NSFaceIDUsageDescription into Info.plist; without it iOS silently
    // falls back to device passcode on Face ID devices. NATIVE change →
    // requires a new EAS Build (not an OTA).
    [
      'expo-local-authentication',
      { faceIDPermission: 'Unlock CF Studio with Face ID.' },
    ],
  ],
```

- [ ] **Step 3: Bump the marketing version** — in `mobile/app.config.js`, change `version: '1.2.1',` to:

```js
  version: '1.3.0',
```

- [ ] **Step 4: Commit**

```bash
git add mobile/app.config.js mobile/package.json mobile/package-lock.json
git commit -m "MOBILE-FACEID.1 — add expo-local-authentication (native) + Face ID plist plugin, v1.3.0"
```

---

## Task 2: Pure logic `mobile/lib/biometric-lock-logic.js` (TDD)

**Files:** Create `mobile/lib/biometric-lock-logic.js`, `mobile/lib/biometric-lock-logic.test.js`

The enum values are **inlined** (not imported from `expo-local-authentication`) so this module has no native import and vitest can run it.

- [ ] **Step 1: Write the failing tests** — `mobile/lib/biometric-lock-logic.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { shouldRelock, biometricLabel, RELOCK_GRACE_MS } from './biometric-lock-logic'

describe('RELOCK_GRACE_MS', () => {
  it('is 5 minutes', () => { expect(RELOCK_GRACE_MS).toBe(5 * 60 * 1000) })
})

describe('shouldRelock', () => {
  const now = 10_000_000
  it('false when never backgrounded', () => {
    expect(shouldRelock(null, now, RELOCK_GRACE_MS)).toBe(false)
    expect(shouldRelock(undefined, now, RELOCK_GRACE_MS)).toBe(false)
  })
  it('false within the grace window', () => {
    expect(shouldRelock(now - (RELOCK_GRACE_MS - 1), now, RELOCK_GRACE_MS)).toBe(false)
  })
  it('true at or past the grace window', () => {
    expect(shouldRelock(now - RELOCK_GRACE_MS, now, RELOCK_GRACE_MS)).toBe(true)
    expect(shouldRelock(now - (RELOCK_GRACE_MS + 5000), now, RELOCK_GRACE_MS)).toBe(true)
  })
})

describe('biometricLabel', () => {
  it('Face ID when FACIAL_RECOGNITION (2) present (wins over fingerprint)', () => {
    expect(biometricLabel([2])).toBe('Face ID')
    expect(biometricLabel([1, 2])).toBe('Face ID')
  })
  it('Touch ID when only FINGERPRINT (1)', () => {
    expect(biometricLabel([1])).toBe('Touch ID')
  })
  it('falls back to "biometrics"', () => {
    expect(biometricLabel([])).toBe('biometrics')
    expect(biometricLabel([3])).toBe('biometrics')
    expect(biometricLabel(null)).toBe('biometrics')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/biometric-lock-logic.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `mobile/lib/biometric-lock-logic.js`:

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mobile/lib/biometric-lock-logic.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/biometric-lock-logic.js mobile/lib/biometric-lock-logic.test.js
git commit -m "MOBILE-FACEID.2 — pure shouldRelock + biometricLabel + tests"
```

---

## Task 3: Native wrapper `mobile/lib/biometric.js`

**Files:** Create `mobile/lib/biometric.js`

No unit test (native bridge + secure-store; validated by `expo export` + on-device).

- [ ] **Step 1: Create the file**

```js
// Thin wrappers over expo-local-authentication + the secure-store prefs for the
// biometric app-lock. The native module is only present in a native build —
// these run a no-op-ish fallback if the bridge is missing, so the JS never hard-
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
```

- [ ] **Step 2: Commit**

```bash
git add mobile/lib/biometric.js
git commit -m "MOBILE-FACEID.3 — biometric capability + authenticate + pref wrappers"
```

---

## Task 4: `LockScreen` overlay + `BiometricLockProvider`

**Files:** Create `mobile/components/LockScreen.jsx`, `mobile/lib/biometric-lock.jsx`

- [ ] **Step 1: Create `mobile/components/LockScreen.jsx`**

```jsx
// Full-screen lock overlay. Absolute-fill on top of the app (which stays
// mounted underneath). `checking` shows a neutral cover while the stored pref
// is read (no flash of app content). Sign out is the escape hatch so a failed
// biometric never permanently locks someone out.
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'

export default function LockScreen({ typeLabel, checking, onUnlock }) {
  const { signOut } = useAuth()
  return (
    <View style={StyleSheet.absoluteFill} className="bg-un1t-bg items-center justify-center px-8">
      <Text className="text-3xl font-bold text-un1t-text mb-2">CF Studio</Text>
      {checking ? (
        <ActivityIndicator className="mt-6" />
      ) : (
        <>
          <Text className="text-sm text-un1t-subtle mb-8 text-center">
            Locked. Unlock with {typeLabel} to continue.
          </Text>
          <Pressable onPress={onUnlock}
            className="flex-row items-center justify-center bg-un1t-text rounded-2xl px-6 py-3.5 active:opacity-80">
            <Ionicons name="lock-open-outline" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-un1t-bg ml-2">Unlock with {typeLabel}</Text>
          </Pressable>
          <Pressable onPress={signOut} className="mt-4 py-2 active:opacity-70">
            <Text className="text-sm text-un1t-subtle">Sign out</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}
```

- [ ] **Step 2: Create `mobile/lib/biometric-lock.jsx`**

```jsx
// Biometric app-lock provider. Sits inside AuthProvider (needs `session`),
// wraps the Stack, and renders the LockScreen overlay on top when locked —
// the app underneath is never unmounted (root-layout navigation-context race).
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { AppState, View, Text, Pressable, Modal } from 'react-native'
import { useAuth } from './auth-context'
import {
  getBiometricCapability, runBiometricAuth, isLockEnabled, setLockEnabledPref,
  wasPromptAsked, markPromptAsked,
} from './biometric'
import { shouldRelock, biometricLabel, RELOCK_GRACE_MS } from './biometric-lock-logic'
import LockScreen from '../components/LockScreen'

const BiometricLockContext = createContext(null)

export function useBiometricLock() {
  return useContext(BiometricLockContext) || { available: false, typeLabel: 'biometrics', enabled: false, setEnabled: async () => ({ success: false }), lockState: 'unlocked', unlock: async () => {} }
}

export function BiometricLockProvider({ children }) {
  const { session } = useAuth()
  const [available, setAvailable] = useState(false)
  const [typeLabel, setTypeLabel] = useState('biometrics')
  const [enabled, setEnabledState] = useState(false)
  const [lockState, setLockState] = useState('unlocked') // 'checking' | 'locked' | 'unlocked'
  const [promptVisible, setPromptVisible] = useState(false)
  const lastBg = useRef(null)
  const booted = useRef(false)

  // Capability — once.
  useEffect(() => {
    let alive = true
    getBiometricCapability().then(({ available: a, types }) => {
      if (!alive) return
      setAvailable(a)
      setTypeLabel(biometricLabel(types))
    })
    return () => { alive = false }
  }, [])

  const promptUnlock = useCallback(async () => {
    const { success } = await runBiometricAuth('Unlock CF Studio')
    if (success) setLockState('unlocked')
    // else: stay locked — LockScreen shows Unlock (retry) + Sign out.
  }, [])

  // Cold-start: decide the lock state from the stored pref the first time a
  // session is present. Clears on sign-out so a later sign-in re-evaluates.
  useEffect(() => {
    if (!session) { booted.current = false; setLockState('unlocked'); return }
    if (booted.current) return
    booted.current = true
    setLockState('checking')
    ;(async () => {
      const on = await isLockEnabled()
      setEnabledState(on)
      if (on) { setLockState('locked'); promptUnlock() }
      else setLockState('unlocked')
    })()
  }, [session, promptUnlock])

  // Re-lock on resume after the grace window.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        lastBg.current = Date.now()
      } else if (next === 'active') {
        if (enabled && session && shouldRelock(lastBg.current, Date.now(), RELOCK_GRACE_MS)) {
          setLockState('locked')
          promptUnlock()
        }
        lastBg.current = null
      }
    })
    return () => sub.remove()
  }, [enabled, session, promptUnlock])

  // One-time enable prompt — first eligible foreground.
  useEffect(() => {
    if (!session || !available || enabled || lockState !== 'unlocked') return
    let alive = true
    wasPromptAsked().then((asked) => { if (alive && !asked) setPromptVisible(true) })
    return () => { alive = false }
  }, [session, available, enabled, lockState])

  // Toggle from settings — re-auth before changing the pref.
  const setEnabled = useCallback(async (on) => {
    const { success } = await runBiometricAuth(on ? `Enable ${typeLabel} lock` : `Disable ${typeLabel} lock`)
    if (!success) return { success: false }
    await setLockEnabledPref(on)
    setEnabledState(on)
    return { success: true }
  }, [typeLabel])

  const onEnableFromPrompt = useCallback(async () => {
    setPromptVisible(false)
    await markPromptAsked()
    const { success } = await runBiometricAuth(`Enable ${typeLabel} lock`)
    if (success) { await setLockEnabledPref(true); setEnabledState(true) }
  }, [typeLabel])

  const onDeclinePrompt = useCallback(async () => {
    setPromptVisible(false)
    await markPromptAsked()
  }, [])

  return (
    <BiometricLockContext.Provider value={{ available, typeLabel, enabled, setEnabled, lockState, unlock: promptUnlock }}>
      {children}
      {lockState !== 'unlocked' && (
        <LockScreen typeLabel={typeLabel} checking={lockState === 'checking'} onUnlock={promptUnlock} />
      )}
      <Modal visible={promptVisible} animationType="fade" transparent onRequestClose={onDeclinePrompt}>
        <View className="flex-1 items-center justify-center bg-black/50 px-8">
          <View className="bg-un1t-bg rounded-3xl p-6 w-full max-w-[340px]">
            <Text className="text-lg font-bold text-un1t-text mb-1">Protect CF Studio with {typeLabel}?</Text>
            <Text className="text-sm text-un1t-subtle mb-5">Require {typeLabel} to open the app and after 5 minutes away. You can change this any time in More.</Text>
            <Pressable onPress={onEnableFromPrompt}
              className="bg-un1t-text rounded-2xl py-3.5 items-center active:opacity-80">
              <Text className="text-base font-semibold text-un1t-bg">Enable {typeLabel}</Text>
            </Pressable>
            <Pressable onPress={onDeclinePrompt} className="py-3 items-center mt-1 active:opacity-70">
              <Text className="text-sm text-un1t-subtle">Not now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </BiometricLockContext.Provider>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add mobile/components/LockScreen.jsx mobile/lib/biometric-lock.jsx
git commit -m "MOBILE-FACEID.4 — BiometricLockProvider + LockScreen overlay + enable prompt"
```

---

## Task 5: Wrap the Stack in `mobile/app/_layout.jsx`

**Files:** Modify `mobile/app/_layout.jsx`

- [ ] **Step 1: Import the provider** — after `import { AuthProvider, useAuth } from '../lib/auth-context'`, add:

```jsx
import { BiometricLockProvider } from '../lib/biometric-lock'
```

- [ ] **Step 2: Wrap the inner content** — replace:

```jsx
        <AuthProvider>
          <StatusBar style="dark" />
          <SplashGate />
          <NotificationRouter />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="tasks" options={{ headerShown: false }} />
            <Stack.Screen name="bookings" options={{ headerShown: false }} />
            <Stack.Screen name="radar" options={{ headerShown: false }} />
          </Stack>
        </AuthProvider>
```

with:

```jsx
        <AuthProvider>
          <BiometricLockProvider>
            <StatusBar style="dark" />
            <SplashGate />
            <NotificationRouter />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="tasks" options={{ headerShown: false }} />
              <Stack.Screen name="bookings" options={{ headerShown: false }} />
              <Stack.Screen name="radar" options={{ headerShown: false }} />
            </Stack>
          </BiometricLockProvider>
        </AuthProvider>
```

- [ ] **Step 3: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error (the `expo-local-authentication` JS bindings resolve in the bundle; the native side is exercised only on a device build).

- [ ] **Step 4: Commit**

```bash
git add mobile/app/_layout.jsx
git commit -m "MOBILE-FACEID.5 — mount BiometricLockProvider around the Stack"
```

---

## Task 6: Face ID toggle in the More tab

**Files:** Modify `mobile/app/(tabs)/more.jsx`

- [ ] **Step 1: Add imports** — add `Switch` to the react-native import, and the hook:

Change `import { View, Text, ScrollView, Pressable, Alert } from 'react-native'` to:

```jsx
import { View, Text, ScrollView, Pressable, Alert, Switch } from 'react-native'
```

and after the `buildSummary` import line, add:

```jsx
import { useBiometricLock } from '../../lib/biometric-lock'
```

- [ ] **Step 2: Read the hook + handler** — inside the `More` component, near the other hook calls (e.g. just after `const { ... } = useAuth()`), add:

```jsx
  const biometric = useBiometricLock()
  async function onToggleBiometric(next) {
    const res = await biometric.setEnabled(next)
    if (!res.success) {
      Alert.alert('Couldn’t confirm', `${biometric.typeLabel} wasn’t confirmed, so the setting wasn’t changed.`)
    }
  }
```

- [ ] **Step 3: Add the toggle row** — immediately before the `{/* Sign out */}` block, add (only renders when biometrics are available):

```jsx
      {biometric.available && (
        <View className="flex-row items-center justify-between mt-6 bg-un1t-surface border border-un1t-border rounded-2xl p-4">
          <View className="flex-1 mr-3">
            <Text className="text-base text-un1t-text">Require {biometric.typeLabel} to unlock</Text>
            <Text className="text-xs text-un1t-subtle mt-0.5">Locks the app on open and after 5 min away.</Text>
          </View>
          <Switch value={biometric.enabled} onValueChange={onToggleBiometric} />
        </View>
      )}
```

- [ ] **Step 4: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error.

- [ ] **Step 5: Commit**

```bash
git add mobile/app/\(tabs\)/more.jsx
git commit -m "MOBILE-FACEID.6 — Require Face ID toggle on the More tab"
```

---

## Task 7: Verify + ship (⚠️ native release — STOP before merge)

**Files:** none.

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports`
Expected: vitest green (incl. `biometric-lock-logic.test.js`); eslint 0 errors; parity clean; mobile-imports clean.

- [ ] **Step 2: Final iOS export**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios && rm -rf dist && cd ..`
Expected: `Exported: dist`.

- [ ] **Step 3: Push + open the PR** (base `main`, head `mobile-faceid-applock`) — title `MOBILE-FACEID — Face ID / Touch ID app-lock`, body summarising the feature + verification, and a **bold warning**: this is a native release; merging would auto-OTA code that crashes existing installs (no native module) — DO NOT merge until the new native binary is built and distributed.

- [ ] **Step 4: STOP — do not merge. Ask the user how to run the native release.** Present the hazard + the path, and let the user decide:

  **The hazard:** merging to `main` triggers `eas-update.yml`, which OTA-publishes to the `production` channel. Existing installs (no `expo-local-authentication` in their binary) would crash on launch. The runtime policy is `sdkVersion`, so old and new SDK-54 binaries currently share the same OTA lane.

  **The safe path (user-driven, per CLAUDE.md deployment runbook):**
  1. Decide OTA isolation — recommended: set an explicit `runtimeVersion` for this release (e.g. `'1.3.0'`) so its OTAs only reach the new binary, never the old one. (This is itself a native-config change; weigh it with the user — the alternative is to merge the JS only *after* everyone is on the new binary.)
  2. `eas build --platform ios --profile production` (and `--platform android`) — a NEW binary that contains the native module.
  3. Submit: iOS via the Release workflow / `eas submit` (App Store/TestFlight); Android — download the `.aab` and upload to Play Internal Testing (org policy blocks automated Android submit).
  4. Once the new binary is the deployed version, merge the JS to `main`.

  Do not run `eas build` or merge without the user's explicit go.

---

## Self-Review

**Spec coverage:** opt-in lock (Task 4 `enabled`/`setEnabled`) ✓ · lock on cold start + 5-min resume (Task 4 effects + Task 2 `shouldRelock`) ✓ · passcode fallback (Task 3 `runBiometricAuth` fallbackLabel, no `disableDeviceFallback`) ✓ · sign-out escape (Task 4 LockScreen) ✓ · one-time enable prompt (Task 4 Modal + `wasPromptAsked`/`markPromptAsked`) ✓ · toggle in More, available-gated, re-auth on change (Task 6 + Task 4 `setEnabled`) ✓ · overlay not remount (Task 4 renders `{children}` always + overlay sibling; Task 5 wrap) ✓ · capability/label detection (Task 3 `getBiometricCapability` + Task 2 `biometricLabel`) ✓ · native plist + module (Task 1) ✓ · pure logic unit-tested (Task 2) ✓ · native-release-not-OTA + the OTA-crash hazard (header + Task 7) ✓ · checking-cover no-flash (Task 4 `'checking'` + LockScreen) ✓.

**Placeholder scan:** none — all code steps complete.

**Type/name consistency:** `shouldRelock`/`biometricLabel`/`RELOCK_GRACE_MS` defined T2, used T4; `getBiometricCapability`/`runBiometricAuth`/`isLockEnabled`/`setLockEnabledPref`/`wasPromptAsked`/`markPromptAsked` defined T3, used T4; `BiometricLockProvider`/`useBiometricLock` defined T4, used T5/T6; `useBiometricLock()` shape `{ available, typeLabel, enabled, setEnabled, lockState, unlock }` consistent T4↔T6; `LockScreen` props `{ typeLabel, checking, onUnlock }` match T4 call site; secure-store keys `biometric_lock_enabled`/`biometric_prompt_asked` consistent in T3.

**Known v1 limitation (noted):** an OS-level RN `Modal` left open when the app is backgrounded can render above the overlay on resume (rare: modal open + ≥5 min away). Acceptable for v1; revisit by dismissing modals on lock if it surfaces.

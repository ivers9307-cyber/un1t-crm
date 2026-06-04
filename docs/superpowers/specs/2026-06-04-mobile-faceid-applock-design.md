# Mobile Face ID / Touch ID App-Lock

**Date:** 2026-06-04 · **Surface:** Expo iOS app (`mobile/`) · **Status:** design approved, ready for plan

## Goal

An **opt-in** biometric app-lock: when enabled, CF Studio requires Face ID / Touch ID to reveal the app on cold launch and after the app has been backgrounded for ≥ 5 minutes. It's a local privacy gate on top of the already-persisted Supabase session — **not** a re-login.

## ⚠️ This is a native release, not an OTA

Adding `expo-local-authentication` (a native module) + the `faceIDPermission` config plugin (writes `NSFaceIDUsageDescription` into `Info.plist`) is a **native change**. Shipping it requires:
1. `cd mobile && npx expo install expo-local-authentication` (updates `package.json` **and** `package-lock.json` together — keeps the lockfile in sync for EAS).
2. The config-plugin entry in `app.config.js` + a version bump (`npm run version:patch`).
3. A new **EAS Build** for iOS **and** Android, then App Store/TestFlight + Play submission (per the CLAUDE.md deployment runbook).

The JS (lock screen, prompt copy, timing) can be OTA-tweaked *after* the capability is in a binary, but the first release with Face ID cannot ride the OTA channel.

## Current architecture (explored)

- `mobile/app/_layout.jsx`: `GestureHandlerRootView > RootErrorBoundary > SafeAreaProvider > AuthProvider > (StatusBar, SplashGate, NotificationRouter, <Stack>)`. **The file warns that re-renders must not churn `<Stack>`** ("Couldn't find the prevent remove context" race) — so the lock must be an *overlay*, never a remount.
- `mobile/lib/auth-context.jsx`: holds `session` + `loading`; splash stays up until `loading` is false.
- `mobile/app/index.jsx`: `session ? /(tabs) : /(auth)/login`.
- **No `AppState` handling today.**

## Approach — overlay, not remount

A new **`BiometricLockProvider`** sits *inside* `AuthProvider` (so it sees `session`) and wraps the Stack. It renders `{children}` (the Stack — **always mounted**) plus an absolute-positioned `<LockScreen>` overlay when locked. Locking never unmounts the navigation tree, sidestepping the documented race. Rejected: folding lock state into `AuthProvider` (bloats the re-render-sensitive context); `expo-secure-store` `requireAuthentication` (clunky UX, no clean 5-min re-lock).

## Components

- **`mobile/lib/biometric.js`** — thin wrappers over `expo-local-authentication`: `getBiometricCapability()` → `{ available, types }` (via `hasHardwareAsync()` + `isEnrolledAsync()` + `supportedAuthenticationTypesAsync()`), and `runBiometricAuth(promptMessage)` → `authenticateAsync({ promptMessage, fallbackLabel: 'Use passcode' })` (returns `{ success, error }`).
- **`mobile/lib/biometric-lock-logic.js`** (pure, unit-tested) — `shouldRelock(lastBackgroundedAt, now, graceMs)` (true when `lastBackgroundedAt != null && now - lastBackgroundedAt >= graceMs`); `biometricLabel(types)` → `'Face ID' | 'Touch ID' | 'biometrics'` from the `AuthenticationType` array.
- **`mobile/lib/biometric-lock.jsx`** — `BiometricLockProvider` + `useBiometricLock()`. State: `available`, `typeLabel`, `enabled` (persisted), `lockState` (`'checking' | 'locked' | 'unlocked'`), `lastBackgroundedAt` (ref). Owns the `AppState` listener, the cold-start sequence, the unlock flow, the enable-prompt, and renders `<LockScreen>`. Exposes `{ available, typeLabel, enabled, setEnabled, lockState, unlock }`.
- **`mobile/components/LockScreen.jsx`** — full-screen absolute overlay: app wordmark, `{typeLabel}` unlock button → `unlock()`, a **"Sign out"** escape. Blank/neutral while `lockState === 'checking'`.

## Persistence

`expo-secure-store` (already a dependency) keys:
- `biometric_lock_enabled` — `'1' | '0'`.
- `biometric_prompt_asked` — `'1'` once the enable-prompt has been shown (so it never nags twice).

These are device-local UI prefs (not secrets), but secure-store is already wired and fine to reuse.

## Lifecycle

1. **Cold start.** On mount, `lockState` starts `'unlocked'` (no session yet → login). When `session` becomes non-null (auth resolved), an effect sets `'checking'` (the overlay covers, blank — prevents a flash of app content as the splash hides), reads `biometric_lock_enabled`, then: enabled → `'locked'` + prompt; else → `'unlocked'`.
2. **Resume.** An `AppState` listener stamps `lastBackgroundedAt` on `background`/`inactive`; on `active`, if `enabled && session && shouldRelock(lastBackgroundedAt, Date.now(), 5*60*1000)` → `'locked'` + prompt.
3. **Unlock.** `runBiometricAuth('Unlock CF Studio')`. Success → `'unlocked'`. iOS passcode fallback is on (default). On cancel/fail the overlay stays with **Try again** + **Sign out** (so a failed biometric never permanently locks the user out; sign-out routes to login).
4. **Sign-out while locked.** `LockScreen`'s Sign out calls `useAuth().signOut()` → session clears → `lockState` → `'unlocked'` (login screen).

## Enable-prompt (opt-in, proactive)

The first eligible foreground — `session && available && !enabled && biometric_prompt_asked !== '1'` — shows a one-time modal *"Protect CF Studio with {typeLabel}?"* → **Enable** (runs `runBiometricAuth` once to confirm enrollment; on success persists `enabled='1'`) / **Not now** (persists `biometric_prompt_asked='1'`). Either way the prompt never reappears; the toggle remains the way to change it later.

## The toggle (More tab)

A **"Require {typeLabel} to unlock"** `Switch` row added to `mobile/app/(tabs)/more.jsx` (in the account/settings area, near Sign out), rendered **only when `available`**. Flipping it on or off first runs `runBiometricAuth` (confirm it's the owner) before mutating `enabled`. Reads/writes via `useBiometricLock()`.

## Edge cases

- **Biometrics unavailable / not enrolled** (`available === false`): no toggle, no prompt, no lock — the feature is invisible.
- **Enrollment removed after enabling:** `runBiometricAuth` fails → the lock screen shows Try again / Sign out; passcode fallback still works, so the user can get in and turn the toggle off.
- **Impersonation / location switch:** unaffected — the lock is a launch/resume gate above the session, orthogonal to `useAuth` state.
- **`checking` flash:** the overlay covers during the brief secure-store read so no app content shows pre-lock.

## Testing

- `mobile/lib/biometric-lock-logic.test.js` (vitest — `mobile/lib/**` in config): `shouldRelock` (null last → false; under grace → false; at/over grace → true) + `biometricLabel` (Face ID / Touch ID / fallback / empty).
- CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports`.
- `cd mobile && npx expo export --platform ios` — JS bundle compiles (the native module's JS bindings resolve; the binary is only needed at runtime).
- **On-device (native build):** the only way to actually exercise biometrics — enable via prompt + toggle; lock on cold start; 5-min resume re-lock; passcode fallback; sign-out escape; toggle off.

## Files

| File | Change |
|---|---|
| `mobile/lib/biometric-lock-logic.js` + `.test.js` | **new** — pure `shouldRelock` + `biometricLabel` |
| `mobile/lib/biometric.js` | **new** — capability + authenticate wrappers |
| `mobile/lib/biometric-lock.jsx` | **new** — provider + context + overlay host |
| `mobile/components/LockScreen.jsx` | **new** — the lock overlay |
| `mobile/app/_layout.jsx` | wrap the Stack with `BiometricLockProvider` |
| `mobile/app/(tabs)/more.jsx` | add the Face ID toggle row |
| `mobile/app.config.js` | add the `expo-local-authentication` plugin + version bump |
| `mobile/package.json` + `package-lock.json` | `expo-local-authentication` dep (via `expo install`) |

No web, schema, API-route, or permission changes.

## Out of scope (v1)

Per-action biometric gating (e.g. re-auth before a sensitive write); a lockout-after-N-failures; Android-specific UX polish (the library covers Android biometrics for free, but the target is iPhone); remembering the unlock across a full app kill (cold start always re-locks when enabled — intended).

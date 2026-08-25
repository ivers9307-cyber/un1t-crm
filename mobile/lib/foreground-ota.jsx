// Foreground OTA update check. checkAutomatically: 'ON_LOAD' only runs on a
// COLD start, and staff rarely force-quit the app — devices sat on stale
// bundles for days (EAS channel insights, 2026-07: the most-run bundle
// predated fixes shipped 3+ days earlier; the PR #908 deep link was live
// server-side while phones ran pre-#908 JS). This component supplements
// ON_LOAD: on every real foreground (the app passed through 'background'
// since it was last active — see the gate's header for why that is keyed on
// evidence, not the previous state's name) it checks for an
// update, throttled to once per 15 minutes, and applies it via reloadAsync()
// only when that can't yank the UI mid-task — just-foregrounded and no
// focused text input — otherwise the downloaded update is applied on the
// NEXT foreground. All throttle/safety decisions live in
// foreground-update-logic.js (pure, unit-tested).
//
// HARDENED like build-info.js: NO top-level expo-updates import — a
// production OTA carrying one crashed on boot inside the expo-updates
// error-recovery path (expo.controller.errorRecoveryQueue). The module is
// lazy-require'd inside try/catch, only when the effect actually runs.

import { useEffect, useRef } from 'react'
import { AppState, TextInput } from 'react-native'
import { createUpdateGate } from './foreground-update-logic'

// Lazily + safely read the expo-updates module. Never throws.
function safeUpdates() {
  try {
    // eslint-disable-next-line global-require
    return require('expo-updates')
  } catch {
    return null
  }
}

// True while a TextInput is focused — the "user is typing" signal that
// blocks an immediate reload. Best-effort: any throw reads as not-focused.
function isInputFocused() {
  try {
    return TextInput.State?.currentlyFocusedInput?.() != null
  } catch {
    return false
  }
}

export function ForegroundOtaUpdater() {
  const gateRef = useRef(null)
  if (!gateRef.current) gateRef.current = createUpdateGate()

  useEffect(() => {
    if (__DEV__) return undefined
    const Updates = safeUpdates()
    // isEnabled is false in Expo Go / builds without the updates config.
    if (!Updates || Updates.isEnabled === false) return undefined

    let inFlight = false

    async function reload() {
      try {
        await Updates.reloadAsync()
      } catch (e) {
        // Reload can refuse (e.g. update rolled back server-side). The app
        // keeps running the current bundle; the next cold start picks up
        // whatever ON_LOAD resolves.
        console.error('[fg-ota] reloadAsync failed', e?.message || e)
      }
    }

    async function check() {
      if (inFlight) return
      inFlight = true
      try {
        const result = await Updates.checkForUpdateAsync()
        if (!result?.isAvailable) return
        await Updates.fetchUpdateAsync()
        const action = gateRef.current.onUpdateFetched(Date.now(), {
          inputFocused: isInputFocused(),
        })
        if (action === 'reload') await reload()
        // 'defer': the gate holds a pending reload for the next foreground.
      } catch {
        // Network flake / manifest hiccup — silent by design. The throttle
        // already stamped, so the next foreground after the window retries.
      } finally {
        inFlight = false
      }
    }

    let prev = AppState.currentState
    const sub = AppState.addEventListener('change', (next) => {
      const action = gateRef.current.onAppStateChange(prev, next, Date.now())
      prev = next
      if (action === 'check') check()
      else if (action === 'reload') reload()
    })
    return () => sub.remove()
  }, [])

  return null
}

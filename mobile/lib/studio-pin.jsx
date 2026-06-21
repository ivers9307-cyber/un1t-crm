// mobile/lib/studio-pin.jsx
// Studio-device PIN lock provider. Sits inside AuthProvider, wraps the
// app, and renders the PIN-pad overlay on top when the device is paired
// AND (idle-locked OR signed out). Mirrors BiometricLockProvider's
// overlay pattern — the app underneath is never unmounted.
//
// On a paired device:
//   - touches reset an idle timer; 5 min idle → lock() (full sign-out)
//   - "Return to PIN" (More) → lock()
//   - a correct PIN mints a fresh Supabase session → the whole app swaps
//     to that staffer via auth-context's onAuthStateChange.
import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { View } from 'react-native'
import { useAuth } from './auth-context'
import { getPairing, clearPairing } from './studio-device'
import { shouldLockForIdle, STUDIO_IDLE_MS } from './studio-pin-lock-logic'
import { supabase } from './supabase'
import StudioPinPad from '../components/StudioPinPad'

const StudioPinContext = createContext(null)

export function useStudioPin() {
  return useContext(StudioPinContext) || {
    paired: false, pairing: null,
    lock: () => {}, unpair: async () => {}, refreshPairing: async () => null,
  }
}

export function StudioPinProvider({ children }) {
  const { session, signOut } = useAuth()
  const [pairing, setPairing] = useState(null)
  const [pairingLoaded, setPairingLoaded] = useState(false)
  const [locked, setLocked] = useState(false)
  const lastActivity = useRef(Date.now())

  const refreshPairing = useCallback(async () => {
    const p = await getPairing()
    setPairing(p)
    setPairingLoaded(true)
    return p
  }, [])

  useEffect(() => { refreshPairing() }, [refreshPairing])

  const paired = !!pairing

  const recordActivity = useCallback(() => { lastActivity.current = Date.now() }, [])

  const lock = useCallback(async () => {
    setLocked(true)
    try { await signOut() } catch { /* best-effort: overlay shows regardless */ }
  }, [signOut])

  const onPinSuccess = useCallback(async ({ access_token, refresh_token }) => {
    await supabase.auth.setSession({ access_token, refresh_token })
    lastActivity.current = Date.now()
    setLocked(false)
  }, [])

  const unpair = useCallback(async () => {
    await clearPairing()
    await refreshPairing()
    setLocked(false)
    try { await signOut() } catch { /* best-effort */ }
  }, [refreshPairing, signOut])

  // Idle timer — only while paired with a live session. Checks every 20s.
  useEffect(() => {
    if (!paired || !session) return
    lastActivity.current = Date.now()
    const iv = setInterval(() => {
      if (shouldLockForIdle(lastActivity.current, Date.now(), STUDIO_IDLE_MS)) lock()
    }, 20_000)
    return () => clearInterval(iv)
  }, [paired, session, lock])

  // Avoid flashing the app/login before we know whether we're paired.
  if (!pairingLoaded) return null

  const showPad = paired && (locked || !session)

  return (
    <StudioPinContext.Provider value={{ paired, pairing, lock, unpair, refreshPairing }}>
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => { recordActivity(); return false }}
      >
        {children}
      </View>
      {showPad && pairing ? (
        <StudioPinPad deviceToken={pairing.token} onSuccess={onPinSuccess} />
      ) : null}
    </StudioPinContext.Provider>
  )
}

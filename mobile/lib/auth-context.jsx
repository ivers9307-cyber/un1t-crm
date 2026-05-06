// Auth state for the mobile app.
//
// On boot we:
//   1. Restore any persisted Supabase session from SecureStore.
//   2. If a session exists, fetch /api/mobile/me to populate profile +
//      locations + permissions.mobile.* in one round-trip.
//   3. Subscribe to Supabase auth state changes so logout / token
//      refresh updates the context automatically.
//
// useAuth() returns the bootstrapped user OR null while loading. Use
// the `loading` flag to show a splash; use `signIn`/`signOut` to mutate.
//
// Active location can be overridden per-call by passing locationId to
// api(); the context exposes a setActiveLocationId() shortcut so the
// More tab's location switcher can mutate it for subsequent calls.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'
import { api } from './api'
import { readImpersonate, writeImpersonate, clearImpersonate } from './impersonate'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)       // safe profile from /api/mobile/me
  const [locations, setLocations] = useState([])
  const [activeLocation, setActiveLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Impersonation surface (mig 035). When non-null, the visible
  // `profile` above is the TARGET's, not the underlying master's.
  // The banner reads this to render "Viewing as X · Stop".
  const [impersonatingFrom, setImpersonatingFrom] = useState(null)

  const refresh = useCallback(async (locationOverride) => {
    const result = await api('/api/mobile/me', { locationId: locationOverride })
    if (result.success && result.data) {
      setProfile(result.data.profile)
      setLocations(result.data.locations || [])
      setActiveLocation(result.data.activeLocation || null)
      setImpersonatingFrom(result.data.impersonatingFrom || null)
      setError(null)
    } else {
      setError(result.error || 'Failed to load profile')
    }
  }, [])

  // Bootstrap on mount.
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (!mounted) return
      setSession(data.session)
      if (data.session) {
        await refresh()
      }
      setLoading(false)
    })()

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        await refresh()
      } else {
        setProfile(null)
        setLocations([])
        setActiveLocation(null)
      }
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [refresh])

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { success: false, error: error.message }
    return { success: true, data }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const setActiveLocationId = useCallback(async (locationId) => {
    if (!locations.find(l => l.id === locationId)) return
    await refresh(locationId)
  }, [locations, refresh])

  // Master "View as user" — start a session. Writes the audit log
  // row server-side, then persists target id locally so api() picks
  // it up via x-impersonate-target on every subsequent call.
  // Re-fetches /me afterward so the visible profile/locations/perms
  // flip to the target's reality without a full reload.
  const startImpersonation = useCallback(async ({ targetUserId, reason }) => {
    const res = await api('/api/mobile/impersonate', {
      method: 'POST',
      body: { target_user_id: targetUserId, reason: reason || null },
    })
    if (!res.success) return res
    await writeImpersonate({ targetId: targetUserId })
    await refresh()  // pulls /me with header now active → swaps profile
    return res
  }, [refresh])

  // Stop the active "View as user" session. Stamps ended_at on the
  // audit row, clears the local target, then re-fetches /me so the
  // master sees their own profile again.
  const stopImpersonation = useCallback(async () => {
    await api('/api/mobile/impersonate/stop', { method: 'POST' })
    await clearImpersonate()
    await refresh()
  }, [refresh])

  // On boot, if SecureStore says we have an impersonation target but
  // it's expired (>24h), clear it. readImpersonate() handles the
  // expiry check internally, so we just call it for the side-effect
  // before refresh() runs. Done here rather than inside refresh()
  // because we want this to happen even if /me fails on first try.
  useEffect(() => {
    readImpersonate().catch(() => {})
  }, [])

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        locations,
        activeLocation,
        loading,
        error,
        impersonatingFrom,
        signIn,
        signOut,
        setActiveLocationId,
        refresh,
        startImpersonation,
        stopImpersonation,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

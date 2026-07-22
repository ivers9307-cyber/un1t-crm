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
import { unregisterCurrentDevicePush } from './push-register'

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
      // STUDIO-NATIVE-PIN — on a paired studio device, cache this user's
      // menu so their next tap-in paints instantly. Best-effort; never
      // blocks or throws into the auth path.
      try {
        const { getPairing, writeMenuCache } = await import('./studio-device')
        if (await getPairing()) {
          writeMenuCache(result.data.profile.id, {
            profile: result.data.profile,
            locations: result.data.locations || [],
            activeLocation: result.data.activeLocation || null,
          })
        }
      } catch { /* best-effort cache */ }
    } else {
      setError(result.error || 'Failed to load profile')
    }
  }, [])

  // STUDIO-NATIVE-PIN — paint a returning staffer's menu from the
  // encrypted per-user cache the instant their session lands, before the
  // network /me returns (stale-while-revalidate). Paired devices only.
  const hydrateFromCache = useCallback(async (userId) => {
    if (!userId) return
    try {
      const { getPairing, readMenuCache } = await import('./studio-device')
      if (!(await getPairing())) return
      const cached = await readMenuCache(userId)
      if (cached?.profile) {
        setProfile(cached.profile)
        setLocations(cached.locations || [])
        setActiveLocation(cached.activeLocation || null)
      }
    } catch { /* best-effort */ }
  }, [])

  // Bootstrap on mount.
  //
  // BOOT-HANG FIX: the splash is shown while `loading` is true (the
  // (auth)/(tabs) layouts render null until then). Previously we did
  // `await refresh()` BEFORE setLoading(false) with no try/catch — so a
  // cold-start /api/mobile/me that hung or threw left `loading` stuck
  // true forever, freezing the app on the splash until a force-quit +
  // reopen (warm session/network) got past it. Now: clear `loading` as
  // soon as the SESSION is known (that's all the routing gates need),
  // and load the profile in the BACKGROUND. A slow/failed profile fetch
  // can no longer block boot. try/finally guarantees loading clears even
  // if getSession itself throws.
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        setSession(data.session)
        if (data.session) {
          // Fire-and-forget — don't block the splash on the network.
          refresh().catch(() => {})
        }
      } catch {
        // getSession failed (e.g. SecureStore read error on cold start) —
        // fall through to the login gate rather than hang.
        if (mounted) setSession(null)
      } finally {
        if (mounted) setLoading(false)
      }
    })()

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        // Paint from cache (instant), then revalidate over the network.
        hydrateFromCache(newSession.user?.id).finally(() => { refresh().catch(() => {}) })
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
  }, [refresh, hydrateFromCache])

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { success: false, error: error.message }
    return { success: true, data }
  }, [])

  // MAGIC-LINK.1 — passwordless login on mobile via a 6-digit email code
  // (the same code the shared Supabase Magic Link email carries; mirrors
  // champ-app/mobile). No deep-link / native release needed. Password sign-in
  // above stays as break-glass. shouldCreateUser:false + project signups OFF
  // means an unknown email can never provision an account.
  const requestCode = useCallback(async (email) => {
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    })
    if (error) return { success: false, error: error.message }
    return { success: true }
  }, [])

  const verifyCode = useCallback(async (email, token) => {
    const { data, error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: token.trim(),
      type: 'email',
    })
    if (error) return { success: false, error: error.message }
    return { success: true, data }
  }, [])

  const signOut = useCallback(async () => {
    // If a "view as user" session is active, close it first so its audit
    // row gets a precise ended_at + the local target is cleared, rather
    // than dangling open until the close-stale-impersonations cron reaps
    // it. Best-effort — never block logout on it.
    try {
      const imp = await readImpersonate()
      if (imp?.targetId) {
        await api('/api/mobile/impersonate/stop', { method: 'POST' })
        await clearImpersonate()
      }
    } catch {
      // ignore — the reaper cron is the backstop
    }
    // Delete this device's push-token registration while the JWT is
    // still valid (the authed DELETE is scoped to user_id server-side,
    // so it must run BEFORE supabase.auth.signOut clears the session).
    // Runs AFTER the impersonation-stop above so the delete executes
    // as the real signed-in user, not a View-as target. Best-effort: a
    // network blip must never block sign-out — worst case the token
    // stays registered until the next sign-in re-upserts it. Without
    // this, a shared/studio device kept receiving the PREVIOUS user's
    // notifications (lead alerts, WhatsApp — customer PII) after
    // sign-out, because a still-valid token never triggers the
    // server's DeviceNotRegistered pruning.
    try {
      await unregisterCurrentDevicePush()
    } catch {
      // ignore — next sign-in re-registers for the new user
    }
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
        requestCode,
        verifyCode,
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

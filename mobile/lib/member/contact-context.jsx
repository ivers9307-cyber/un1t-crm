// PHASE2 (one-app merge, stage B) — champ's lib/auth-context.jsx ported as
// the member CONTACT context. It consumes the SHARED Supabase client
// (lib/supabase via the member shim) and keeps the contact-loading logic
// compiling; it is NOT mounted anywhere yet — the member tree is unreachable
// until the stage-C resolver lands, and stage C wires the providers.
//
// The exported names stay `AuthProvider`/`useAuth` so every ported member
// screen (which imported champ's auth-context) compiles unchanged.
//
// TODO(stage C) — side-effect wiring REMOVED from champ's original, to be
// re-decided when the identity spine lands (none of it may fire from a
// shared-session app as-is):
//   - link-contact fallback: on a missing contacts row champ POSTed
//     /api/mobile/link-contact (member-app deployment) then re-read; in the
//     merged app self-linking against a STAFF session would be wrong.
//   - review-login: requestCode/verifyCode carried the App-Store demo
//     account gate (DEMO_REVIEW_EMAIL → POST /api/mobile/review-login).
//     Champ's (auth) group is not ported; stage C merges auth flows.
//   - signOut: champ unregistered device push, cleared the outgoing
//     contact's per-contact HealthKit SecureStore keys (hkConnectedKey /
//     hkCursorKey), then supabase.auth.signOut({ scope: 'local' }). On the
//     SHARED client that would end the staff session too — so here it is a
//     deliberate no-op stub that only keeps consumers compiling.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [contact, setContact] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadContact = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setContact(null); return }
    const { data } = await supabase
      .from('contacts')
      .select('id, name, email, dob, gender, weight_kg, profile_setup_completed_at')
      .eq('user_id', user.id)
      .maybeSingle()
    // TODO(stage C): champ's link-contact fallback lived here (see header).
    setContact(data || null)
  }, [])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        setSession(data.session)
        if (data.session) loadContact().catch(() => {})
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (!newSession) {
        setContact(null)
        return
      }
      // TOKEN_REFRESHED (and USER_UPDATED) fires hourly and carries the same
      // identity — skip the contact reload on those. Only load on meaningful
      // auth transitions.
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return
      loadContact().catch(() => {})
    })
    return () => { mounted = false; sub?.subscription?.unsubscribe?.() }
  }, [loadContact])

  // TODO(stage C): deliberate no-op — see the header for what champ's
  // signOut did and why it must not run against the shared session.
  const signOut = useCallback(async () => {}, [])

  return (
    <AuthContext.Provider value={{ session, contact, loading, signOut, refresh: loadContact }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

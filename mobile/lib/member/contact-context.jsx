// PHASE2 (one-app merge) — champ's lib/auth-context.jsx as the member
// CONTACT context, now fully wired to the identity spine (stage C). It
// consumes the SHARED Supabase client and is mounted as the (member)
// tree's provider by app/(member)/_layout.jsx.
//
// The exported names stay `AuthProvider`/`useAuth` so every ported member
// screen (which imported champ's auth-context) compiles unchanged.
//
// Stage-C wiring decisions (locked):
//   - link-contact fallback: champ POSTed /api/mobile/link-contact when a
//     signed-in user had no contacts row, then re-read. In the merged app
//     that self-link is policy-gated (lib/identity.js
//     shouldAttemptLinkContact): it fires ONLY when the staff probe
//     CONFIRMED not_staff, the device has never held a staff session
//     (has_ever_been_staff unset — staff linking is admin-only), and the
//     member probe CONFIRMED empty. Any 'unknown' leg ⇒ no self-link.
//   - review-login / requestCode / verifyCode: NOT here — the staff login
//     is the merged app's only auth entry (champ's (auth) group is not
//     ported; the resolver owns entry). REPSET-PUB.3A ported champ's App
//     Store reviewer gate onto THAT one entry instead of re-adding a member
//     login: lib/auth-context.jsx's requestCode/verifyCode branch on the demo
//     email, and the resolver then lands the (member-only) reviewer session
//     here exactly as it lands any other member.
//   - signOut: the ONE teardown union (lib/sign-out.js) — both shells'
//     sign-outs are identical in the one-session model.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './supabase'
import { api } from './api'
import { performFullSignOut } from '../sign-out'
import { useIdentity } from '../identity-context'
import { UNKNOWN, probeMember, shouldAttemptLinkContact, getHasEverBeenStaff, writeCachedMemberContactId } from '../identity'

const CONTACT_COLUMNS = 'id, name, email, dob, gender, weight_kg, profile_setup_completed_at'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const identity = useIdentity()
  const [session, setSession] = useState(null)
  // Seed from the identity spine's boot probe so the member tree paints
  // without a second contacts read on entry.
  const [contact, setContact] = useState(identity.contact || null)
  const [loading, setLoading] = useState(true)
  const { staffState } = identity

  const loadContact = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setContact(null); return }
    // BAREWRITE.1 — the member leg is a TRI-state probe, not a boolean. This
    // read used to discard `error` and then hand shouldAttemptLinkContact a
    // hard-coded NO_MEMBER, so a transient failure (offline, 5xx, RLS blip)
    // read as "CONFIRMED no contacts row" and fired the silent self-link —
    // exactly the "any unknown leg ⇒ no self-link" rule identity.js exists to
    // enforce. probeMember() already encodes the correct fold; use it rather
    // than re-deriving the state here.
    const probe = await probeMember({
      fetchContact: () => supabase
        .from('contacts')
        .select(CONTACT_COLUMNS)
        .eq('user_id', user.id)
        .maybeSingle(),
    })
    let data = probe.contact || null
    if (probe.state === UNKNOWN) {
      // Unreadable leg: leave whatever the identity spine already resolved in
      // place rather than blanking a known contact on a transient failure.
      return
    }
    if (!data) {
      // App-first member who never clicked the web invite link — self-link
      // by email, ONLY when the identity policy allows (see header).
      // SecureStore is re-read here (not the context snapshot) so a staff
      // probe that landed after this provider mounted still hard-disables
      // the fallback.
      const hasEverBeenStaff = await getHasEverBeenStaff()
      if (shouldAttemptLinkContact({ staffState, hasEverBeenStaff, memberState: probe.state })) {
        try { await api('/api/mobile/link-contact', { method: 'POST' }) } catch { /* best-effort */ }
        const reread = await probeMember({
          fetchContact: () => supabase.from('contacts').select(CONTACT_COLUMNS).eq('user_id', user.id).maybeSingle(),
        })
        // An unreadable re-read is not "the link produced nothing" — hold the
        // current contact rather than publishing a null the next render would
        // read as "not a member".
        if (reread.state === UNKNOWN) return
        data = reread.contact || null
      }
    }
    if (data?.id) writeCachedMemberContactId(data.id).catch(() => {})
    setContact(data || null)
  }, [staffState])

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
      // identity — skip the contact load/link on those so link-contact can
      // never re-POST on every refresh. Only load on meaningful transitions.
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return
      loadContact().catch(() => {})
    })
    return () => { mounted = false; sub?.subscription?.unsubscribe?.() }
  }, [loadContact])

  // The one-session teardown union — identical to the staff shell's
  // sign-out (kiosk idle-lock included). See lib/sign-out.js.
  const signOut = useCallback(async () => {
    await performFullSignOut()
  }, [])

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

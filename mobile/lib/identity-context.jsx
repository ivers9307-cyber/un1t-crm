// PHASE2 stage C — the identity spine's React surface. Mounted once in the
// root layout (inside AuthProvider); owns the boot-time resolution the
// entry route consumes, plus the dual-identity state the switcher renders.
//
// Resolution order (design point 3):
//   1. paired studio kiosk  → staff shell ONLY, no probes (a kiosk must
//      never probe/link a member identity)
//   2. active impersonation → member mode suppressed (the underlying JWT
//      is a master — a staff identity by construction)
//   3. parallel probes (staff /me + member contacts row), each time-boxed
//      so an outage can only ever cost PROBE_TIMEOUT_MS of splash, never
//      wedge boot. Timeouts resolve 'unknown' — and 'unknown' never
//      demotes (lib/identity.js owns the rules).
//
// Auth-event re-probes (TOKEN_REFRESHED / SIGNED_IN) may upgrade
// (unknown→staff) but never downgrade an active mode.

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import Constants from 'expo-constants'
import { supabase } from './supabase'
import { useAuth } from './auth-context'
import { getPairing } from './studio-device'
import { readImpersonate } from './impersonate'
import {
  STAFF, UNKNOWN, MEMBER,
  probeStaff, probeMember, applyReprobe, resolveEntryRoute,
  getHasEverBeenStaff, setHasEverBeenStaff, writeCachedMemberContactId,
} from './identity'
import { readLastSide, writeLastSide } from './last-side'

const API_BASE = Constants.expoConfig?.extra?.apiBaseUrl

// Generous enough for a cold radio wake, small enough that an outage costs
// seconds of splash, not a hang.
const PROBE_TIMEOUT_MS = 10000

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      () => { clearTimeout(t); resolve(fallback) }
    )
  })
}

// GET /api/mobile/me with the CURRENT access token. Plain Bearer only — the
// probe asks "is this session a staff profile", never "who am I viewing as",
// so no impersonation/location headers. Throws on network failure (the pure
// probe maps that to 'unknown').
async function fetchMeRaw() {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${API_BASE}/api/mobile/me`, {
    headers: {
      Accept: 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  })
  let json = null
  try { json = await res.json() } catch { /* status is what matters */ }
  return { status: res.status, json }
}

async function refreshSessionRaw() {
  const { error } = await supabase.auth.refreshSession()
  return !error
}

// The member probe: a contacts row linked to this user_id, via the shared
// client (RLS-scoped). Same column list as the member contact-context.
async function fetchContactRaw() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: null }
  return supabase
    .from('contacts')
    .select('id, name, email, dob, gender, weight_kg, profile_setup_completed_at')
    .eq('user_id', user.id)
    .maybeSingle()
}

const initialState = {
  resolving: true,
  paired: false,
  impersonating: false,
  staffState: UNKNOWN,
  memberState: UNKNOWN,
  contact: null,
  hasEverBeenStaff: false,
  lastSide: null,
  entryRoute: null,
}

const IdentityContext = createContext(null)

export function IdentityProvider({ children }) {
  const { session, loading } = useAuth()
  const [state, setState] = useState(initialState)
  // The probes race auth-state churn; only the latest resolution may land.
  const runRef = useRef(0)

  const resolve = useCallback(async ({ userId }) => {
    const run = ++runRef.current
    const commit = (next) => { if (runRef.current === run) setState(next) }

    if (!userId) {
      commit({ ...initialState, resolving: false })
      return
    }

    const [pairing, imp] = await Promise.all([
      getPairing().catch(() => null),
      readImpersonate().catch(() => null),
    ])

    if (pairing) {
      // Kiosk: staff shell only; member mode suppressed entirely, member
      // probe deliberately never runs on a shared device.
      commit({
        ...initialState,
        resolving: false,
        paired: true,
        staffState: STAFF,
        entryRoute: resolveEntryRoute({ paired: true, impersonating: false, staffState: STAFF, memberState: UNKNOWN, lastSide: null }),
      })
      return
    }

    if (imp?.targetId) {
      // Impersonating (master-only capability ⇒ staff by construction).
      commit({
        ...initialState,
        resolving: false,
        impersonating: true,
        staffState: STAFF,
        entryRoute: resolveEntryRoute({ paired: false, impersonating: true, staffState: STAFF, memberState: UNKNOWN, lastSide: null }),
      })
      return
    }

    const [hasStaffHistory, lastSide, staffRes, memberRes] = await Promise.all([
      getHasEverBeenStaff(),
      readLastSide(),
      withTimeout(
        probeStaff({ fetchMe: fetchMeRaw, refreshSession: refreshSessionRaw }),
        PROBE_TIMEOUT_MS,
        { state: UNKNOWN }
      ),
      withTimeout(
        probeMember({ fetchContact: fetchContactRaw }),
        PROBE_TIMEOUT_MS,
        { state: UNKNOWN }
      ),
    ])

    if (staffRes.state === STAFF) await setHasEverBeenStaff()
    if (memberRes.state === MEMBER && memberRes.contact?.id) {
      await writeCachedMemberContactId(memberRes.contact.id)
    }

    commit({
      resolving: false,
      paired: false,
      impersonating: false,
      staffState: staffRes.state,
      memberState: memberRes.state,
      contact: memberRes.contact || null,
      hasEverBeenStaff: hasStaffHistory || staffRes.state === STAFF,
      lastSide,
      entryRoute: resolveEntryRoute({
        paired: false,
        impersonating: false,
        staffState: staffRes.state,
        memberState: memberRes.state,
        lastSide,
      }),
    })
  }, [])

  // Boot + user-change resolution. Keyed on the USER id, not the session
  // object — token refreshes mint new session objects hourly and must not
  // re-run the full resolution (the upgrade-only re-probe below covers
  // them).
  const userId = session?.user?.id || null
  useEffect(() => {
    if (loading) return
    resolve({ userId })
  }, [loading, userId, resolve])

  // Upgrade-only re-probe on token refresh: the request rides a token from
  // a JUST-successful refresh, so a 401 is immediately conclusive — but
  // applyReprobe never demotes an active mode regardless. Reads the latest
  // state via a ref so the listener never triggers probes from inside a
  // state updater.
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'TOKEN_REFRESHED') return
      const cur = stateRef.current
      if (cur.resolving || cur.paired || cur.impersonating) return
      if (cur.staffState === STAFF) return // nothing to upgrade
      probeStaff({ fetchMe: fetchMeRaw, refreshSession: refreshSessionRaw, justRefreshed: true })
        .then((res) => {
          setState((prev) => {
            const nextStaff = applyReprobe(prev.staffState, res.state)
            if (nextStaff === prev.staffState) return prev
            if (nextStaff === STAFF) setHasEverBeenStaff()
            return {
              ...prev,
              staffState: nextStaff,
              hasEverBeenStaff: prev.hasEverBeenStaff || nextStaff === STAFF,
              entryRoute: resolveEntryRoute({
                paired: prev.paired,
                impersonating: prev.impersonating,
                staffState: nextStaff,
                memberState: prev.memberState,
                lastSide: prev.lastSide,
              }),
            }
          })
        })
        .catch(() => { /* best-effort */ })
    })
    return () => sub?.subscription?.unsubscribe?.()
  }, [])

  // The switcher (and the merged notification router via lib/last-side
  // directly) persists the side; this keeps React state in step.
  const setSide = useCallback((side) => {
    writeLastSide(side).catch(() => {})
    setState((prev) => ({ ...prev, lastSide: side }))
  }, [])

  const dual = state.staffState === STAFF && state.memberState === MEMBER

  return (
    <IdentityContext.Provider value={{ ...state, dual, setSide }}>
      {children}
    </IdentityContext.Provider>
  )
}

export function useIdentity() {
  const ctx = useContext(IdentityContext)
  if (!ctx) throw new Error('useIdentity must be used inside <IdentityProvider>')
  return ctx
}

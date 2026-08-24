// mobile/lib/use-physical-location.js
//
// HOME-LOC.5 — "which studio is this phone standing in", resolved on screen
// focus and then FROZEN for the visit (a GPS wobble must never swap which
// studio a thumb is about to command mid-screen). All decisions live in
// physical-location.js (pure, tested); this file only does IO.
//
// HOME-LOC.12 — the freeze breaks on two explicit events, both of which mean
// "the phone may have MOVED", which is not what the freeze guards against:
// an app FOREGROUND while the screen is focused (spec §2), and refresh().
//
// Never REQUESTS location permission — it reads the existing grant. The
// attendance gate owns the permission ask; a denied user simply never gets
// the on-site flip and Home renders its offsite layout (which needs no
// location at all).
//
// Status: 'loading' → exactly one of 'at_studio' | 'offsite' | 'unknown'.
// Returns { status, location, foregroundPermission, refresh } —
// foregroundPermission ('granted'|'ask'|'settings'|'unknown') feeds Home's
// enable-location nudge (LOC-NUDGE.1); refresh() is the explicit
// re-resolve a pull-to-refresh calls (HOME-LOC.8b). Nothing else re-reads
// within a visit except an app foreground (HOME-LOC.12), which is the freeze
// this hook exists for.

import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Location from 'expo-location'
import { useFocusEffect } from 'expo-router'
import { api } from './api'
import { useAuth } from './auth-context'
import { resolvePhysicalLocation, pickPosition, mapForegroundPermission } from './physical-location'

const CONFIG_TTL_MS = 5 * 60 * 1000
const CONFIG_TIMEOUT_MS = 10000
const POSITION_TIMEOUT_MS = 8000
// Well inside pickPosition's 5-minute staleness gate, so a cache hit can
// never resurrect a fix that module would have rejected.
const POSITION_TTL_MS = 45 * 1000

// Module-level config cache: five screens resolve on focus; the regions
// change ~never. Kept on failure — a blip must not blind detection.
let regionsCache = { at: 0, regions: null }

// Module-level position cache. Without it, Home → Sonos → Home → Shelly is
// four Balanced GPS acquisitions and four loading repaints for one walk
// across one room. The VERDICT is deliberately not cached — every focus
// re-resolves (regions and `locations` may have changed, and re-deciding is
// free) — only the expensive radio read is shared.
let positionCache = { at: 0, position: null }

/**
 * Drop both caches. Registered in the sign-out teardown union
 * (lib/sign-out.js): they are module-level and would otherwise outlive the
 * session on a shared studio device — the next user would resolve against
 * the previous user's regions and, worse, their last position fix.
 */
export function clearPhysicalLocationCaches() {
  regionsCache = { at: 0, regions: null }
  positionCache = { at: 0, position: null }
}

async function fetchRegions() {
  const now = Date.now()
  if (regionsCache.regions && now - regionsCache.at <= CONFIG_TTL_MS) return regionsCache.regions
  try {
    // No impersonation guard, unlike geofence.js's syncGeofences(): this
    // read REGISTERS nothing and STAMPS nothing — it only asks "what are
    // the region coordinates". During View-as the config comes back as the
    // target, which is the same reality the rest of the screen already
    // renders (spec §2: position is the real device's, filtering is the
    // impersonated profile's), and the resolved location is then
    // intersected with the visible `locations` anyway.
    const res = await api('/api/attendance/geofence-config')
    if (res?.success) {
      // all_regions is exemption-blind (HOME-LOC.1); `regions` fallback only
      // covers a stale server during the deploy window.
      const regions = res.data?.all_regions ?? res.data?.regions ?? []
      regionsCache = { at: now, regions }
      return regions
    }
  } catch { /* fall through to last good */ }
  return regionsCache.regions || []
}

/** Bound a promise that has no cancellation of its own. `label` is the
 *  rejection message — both call sites below would otherwise report the
 *  other one's failure. */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// The whole IO path, hoisted out of the focus effect (HOME-LOC.8b) so the
// explicit refresh() below runs the SAME resolution rather than a second
// copy that could drift from it. Never throws — every failure lands on
// 'unknown', which renders the offsite layout.
async function resolveOnce(locations) {
  // foregroundPermission rides along for Home's enable-location nudge
  // (LOC-NUDGE.1): 'unknown' until the read lands, so the nudge can never
  // fire off an unread or unreadable permission.
  let next = { status: 'unknown', location: null, foregroundPermission: 'unknown' }
  try {
    const [perm, regions] = await Promise.all([
      Location.getForegroundPermissionsAsync().catch(() => null),
      // api() builds on a bare fetch with no AbortSignal, so a hung
      // request would otherwise pin this hook at 'loading' until the
      // platform socket timeout — re-armed on every focus. The
      // abandoned fetch still populates regionsCache if it lands, so
      // the next focus gets the answer.
      withTimeout(fetchRegions(), CONFIG_TIMEOUT_MS, 'geofence-config timeout')
        .catch(() => regionsCache.regions || []),
    ])
    next.foregroundPermission = mapForegroundPermission(perm)
    if (perm?.status === 'granted' && regions.length > 0) {
      let current = null
      if (positionCache.position && Date.now() - positionCache.at <= POSITION_TTL_MS) {
        current = positionCache.position
      } else {
        try {
          current = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            POSITION_TIMEOUT_MS,
            'position timeout'
          )
          // Only cache a fix pickPosition would actually accept — a
          // stale/replayed read would otherwise pin every screen at
          // 'unknown' for the full TTL instead of retrying next focus.
          if (pickPosition({ current, nowMs: Date.now() })) {
            positionCache = { at: Date.now(), position: current }
          }
        } catch { /* fall back to lastKnown below */ }
      }
      const lastKnown = current ? null : await Location.getLastKnownPositionAsync().catch(() => null)
      const position = pickPosition({ current, lastKnown, nowMs: Date.now() })
      next = { ...resolvePhysicalLocation({ position, regions, locations }), foregroundPermission: 'granted' }
    }
  } catch { /* stays unknown */ }
  return next
}

export function usePhysicalLocation() {
  const { profile, locations } = useAuth()
  const [result, setResult] = useState({ status: 'loading', location: null, foregroundPermission: 'unknown' })
  const visitRef = useRef(0)

  // Read through a ref, not the closure. The effect below is keyed on the
  // id SET (see locationIds), so the captured array would otherwise be
  // whichever one was current at the last id-set change — and the location
  // OBJECTS inside it carry the per-location feature flags the on-site
  // tiles gate on, which a /me refresh can legitimately update without the
  // id set moving at all.
  const locationsRef = useRef(locations)
  locationsRef.current = locations

  // Key the effect on the assignment SET, not the array identity.
  // auth-context re-runs setLocations() on every /me refresh — boot, token
  // refresh, View-as, location switch — minting a NEW array each time with
  // identical contents. Keying on `locations` itself would therefore tear
  // the effect down and re-run it MID-VISIT on a background token refresh:
  // a loading flash and a second GPS read on a screen the user is already
  // looking at, i.e. exactly the mid-screen flip the freeze exists to
  // prevent. A change of the id set IS a change of reality and SHOULD
  // re-resolve. `profile?.id` rides along for the same reason: it is what
  // re-arms the effect once the gate below opens (and it flips on View-as).
  // Same `ids.join(',')` idiom as staff/roles/[id].jsx.
  const locationIds = (locations || []).map((l) => l?.id).sort().join(',')

  useFocusEffect(
    useCallback(() => {
      const visit = ++visitRef.current
      let active = true
      const fresh = () => active && visitRef.current === visit

      async function resolve() {
        const next = await resolveOnce(locationsRef.current)
        if (fresh()) setResult(next)
      }

      // Back to 'loading' on every focus rather than keeping the last
      // answer while revalidating: the previous visit's answer is a claim
      // about where the phone was THEN, and re-showing it is how a coach
      // ends up commanding the studio they left. Spec §3 State C paints a
      // skeleton for this; only the SHIFT lists paint stale-while-revalidate.
      setResult({ status: 'loading', location: null, foregroundPermission: 'unknown' })

      // Stay at 'loading' until the profile lands. auth-context seeds
      // `locations` to [] and clears its own `loading` as soon as the
      // SESSION is known — before /me returns — so resolving here on a cold
      // start would burn a full GPS acquisition to reach the one answer an
      // empty assignment list can give ('offsite', via the no-matching-id
      // branch of resolvePhysicalLocation), paint the whole offsite Home,
      // and then resolve a second time when /me lands. `profile?.id` in the
      // deps is what re-runs this once it does.
      if (!profile) return () => { active = false }

      resolve()

      // HOME-LOC.12 — spec §2 promises resolution on focus OR app foreground,
      // and focus alone is not enough: a coach can leave a control screen open,
      // drive to the other gym, and RESUME the app, at which point the screen
      // never re-focuses and the frozen green "detected" pill keeps asserting
      // the studio they left — with no recovery route on the control screens.
      // The per-visit freeze protects against GPS wobble MID-VISIT; it was
      // never meant to survive the phone having been to another gym while
      // backgrounded. Same treatment as refresh(): bump the visit (so an
      // in-flight resolve's fresh() fails and cannot land late over this one),
      // drop the position cache (a resume after time away is exactly when a
      // cached fix is suspect), and re-run the SAME resolveOnce path.
      //
      // Subscribed INSIDE the focus effect, so it exists only while this
      // screen is focused and comes off in the cleanup below — the blurred
      // screens' hooks must not all re-resolve on every foreground.
      //
      // Subscription idiom (previous-state ref + remove() on cleanup) follows
      // foreground-ota.jsx. The GATE is deliberately looser than a
      // `prev === 'background'` check: ANY non-active → 'active' counts.
      // RN's iOS willEnterForeground mapping has differed across versions —
      // 0.86 hardcodes it to "background" (real foregrounds report
      // background→active directly; verified in RCTAppState.mm), but older
      // RNs read the live applicationState there and emitted
      // background→INACTIVE→active, under which a background-only gate is
      // dead code. Gating on a state NAME ties correctness to that upstream
      // mapping; this gate does not. It can only OVER-resolve (a
      // control-centre pull-down costs one GPS read and a spinner); it cannot
      // under-resolve, and a stale green "detected" pill asserting the wrong
      // studio is far worse than a spare acquisition. LocationGate.jsx uses
      // the same `s === 'active'` shape.
      //
      // The gate discriminates on TIME AWAY, not the state name: a Control
      // Centre / notification-shade glance round-trips inactive → active in
      // seconds, and re-resolving on that would drop the position cache and
      // put the screen through 'loading' — during which the resolution falls
      // back to activeLocation, a mid-visit retarget the per-visit freeze
      // exists to prevent. Under POSITION_TTL_MS the cached fix is still
      // good and the frozen verdict still true; over it, the phone may
      // genuinely have been to the other gym.
      let prev = AppState.currentState
      let leftAt = 0
      const sub = AppState.addEventListener('change', (nextState) => {
        const wasAway = prev !== 'active'
        if (nextState !== 'active') {
          if (!wasAway) leftAt = Date.now()
          prev = nextState
          return
        }
        prev = nextState
        if (!wasAway || Date.now() - leftAt <= POSITION_TTL_MS) return
        const fgVisit = ++visitRef.current
        positionCache = { at: 0, position: null }
        setResult({ status: 'loading', location: null, foregroundPermission: 'unknown' })
        resolveOnce(locationsRef.current).then((next) => {
          if (active && visitRef.current === fgVisit) setResult(next)
        })
      })

      return () => { active = false; sub.remove() }
    }, [locationIds, profile?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  )

  // HOME-LOC.8b — an EXPLICIT re-resolve, for a pull-to-refresh. The gesture
  // means "I have moved", so it must actually re-read the radio: the
  // position cache is dropped first (dropped, not bypassed — every other
  // screen's ≤45s cached fix is equally stale once the user has told us so).
  // The region cache is deliberately kept: its TTL answers "where are the
  // studios", which a refresh gesture says nothing about.
  //
  // Bumping visitRef is what makes this safe against an in-flight focus
  // resolve — that resolve's `fresh()` now fails, so an older answer landing
  // late can never overwrite this one.
  const refresh = useCallback(async () => {
    // Keyed on the id, not the object: auth-context mints a new `profile`
    // on every /me refresh, and an unstable refresh() would churn every
    // caller's onRefresh deps.
    if (!profile?.id) return
    const visit = ++visitRef.current
    positionCache = { at: 0, position: null }
    setResult({ status: 'loading', location: null, foregroundPermission: 'unknown' })
    const next = await resolveOnce(locationsRef.current)
    if (visitRef.current === visit) setResult(next)
    // locationsRef is read through the ref for the reason documented above.
  }, [profile?.id])

  return { ...result, refresh }
}

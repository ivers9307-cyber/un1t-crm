// mobile/lib/use-physical-location.js
//
// HOME-LOC.5 — "which studio is this phone standing in", resolved ONCE per
// screen focus and then FROZEN for the visit (a GPS wobble must never swap
// which studio a thumb is about to command mid-screen). All decisions live
// in physical-location.js (pure, tested); this file only does IO.
//
// Never REQUESTS location permission — it reads the existing grant. The
// attendance gate owns the permission ask; a denied user simply never gets
// the on-site flip and Home renders its offsite layout (which needs no
// location at all).
//
// Status: 'loading' → exactly one of 'at_studio' | 'offsite' | 'unknown'.

import { useCallback, useRef, useState } from 'react'
import * as Location from 'expo-location'
import { useFocusEffect } from 'expo-router'
import { api } from './api'
import { useAuth } from './auth-context'
import { resolvePhysicalLocation, pickPosition } from './physical-location'

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

export function usePhysicalLocation() {
  const { profile, locations } = useAuth()
  const [result, setResult] = useState({ status: 'loading', location: null })
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
        let next = { status: 'unknown', location: null }
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
                positionCache = { at: Date.now(), position: current }
              } catch { /* fall back to lastKnown below */ }
            }
            const lastKnown = current ? null : await Location.getLastKnownPositionAsync().catch(() => null)
            const position = pickPosition({ current, lastKnown, nowMs: Date.now() })
            next = resolvePhysicalLocation({ position, regions, locations: locationsRef.current })
          }
        } catch { /* stays unknown */ }
        if (fresh()) setResult(next)
      }

      // Back to 'loading' on every focus rather than keeping the last
      // answer while revalidating: the previous visit's answer is a claim
      // about where the phone was THEN, and re-showing it is how a coach
      // ends up commanding the studio they left. Spec §3 State C paints a
      // skeleton for this; only the SHIFT lists paint stale-while-revalidate.
      setResult({ status: 'loading', location: null })

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
      return () => { active = false }
    }, [locationIds, profile?.id])  // eslint-disable-line react-hooks/exhaustive-deps
  )

  return result
}

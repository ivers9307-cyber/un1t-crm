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
const POSITION_TIMEOUT_MS = 8000

// Module-level config cache: five screens resolve on focus; the regions
// change ~never. Kept on failure — a blip must not blind detection.
let regionsCache = { at: 0, regions: null }

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

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('position timeout')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export function usePhysicalLocation() {
  const { locations } = useAuth()
  const [result, setResult] = useState({ status: 'loading', location: null })
  const visitRef = useRef(0)

  // Depend on the assignment SET, not the array identity. auth-context
  // re-runs setLocations() on every /me refresh — boot, token refresh,
  // View-as, location switch — minting a NEW array each time with identical
  // contents. Keying the effect on `locations` itself would therefore tear
  // down and re-run it MID-VISIT on a background token refresh: a loading
  // flash and a second GPS read on a screen the user is already looking at,
  // i.e. exactly the mid-screen flip the freeze exists to prevent.
  // A change of the id set IS a change of reality and SHOULD re-resolve —
  // most importantly on cold start, where Home focuses with `locations`
  // still [] and /me lands a moment later (resolving against [] can only
  // ever say 'offsite'). Same `ids.join(',')` idiom as staff/roles/[id].jsx.
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
            fetchRegions(),
          ])
          if (perm?.status === 'granted' && regions.length > 0) {
            let current = null
            try {
              current = await withTimeout(
                Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
                POSITION_TIMEOUT_MS
              )
            } catch { /* fall back to lastKnown below */ }
            const lastKnown = current ? null : await Location.getLastKnownPositionAsync().catch(() => null)
            const position = pickPosition({ current, lastKnown, nowMs: Date.now() })
            next = resolvePhysicalLocation({ position, regions, locations })
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
      resolve()
      return () => { active = false }
    }, [locationIds])  // eslint-disable-line react-hooks/exhaustive-deps
  )

  return result
}

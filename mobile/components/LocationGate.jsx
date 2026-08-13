// mobile/components/LocationGate.jsx
//
// GEO-ATT — hard gate (Richard, 2026-07-30): staff with geofence
// attendance enabled at any of their locations must grant background
// ("Always") location before they can use the app. Exempt staff and
// users at non-geofence locations get required=false and never see
// this. Re-checks on every foreground so returning from Settings
// unblocks without a relaunch.
//
// GEO-ATT.12 — rendered as a ROOT-LEVEL FULL-SCREEN OVERLAY (a sibling
// after <Stack> in app/_layout.jsx), not a wrapper around one route
// group: push-notification deep links land on sibling screen groups
// (contacts, schedule, approvals, …) that sit on top of (tabs), so a
// tabs-only wrap was bypassable. When not blocked it renders null; when
// blocked it absolutely fills the screen above the (still-mounted)
// navigator so nothing underneath is visible or touchable. Renders
// nothing without a session, so login is never covered.

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, AppState, Linking } from 'react-native'
import * as Location from 'expo-location'
import { useAuth } from '../lib/auth-context'
import { api } from '../lib/api'
import { syncGeofences } from '../lib/geofence'
import { reportDeviceState } from '../lib/push-register'

// STAFF-DEV.7 — collapse the two OS permission reads into the single
// value the CRM stores (mig 466's CHECK values).
//
// Background-first by design: this column answers "can geofence
// attendance actually fire on this phone?", so an iOS user on "While
// Using" (whose BACKGROUND status expo reports as denied) is a denial
// for that purpose. `when_in_use` is therefore mainly an Android shape —
// background still undetermined while foreground is granted.
function mapPermission(bg, fg) {
  if (bg?.status === 'granted') return 'always'
  if (bg?.status === 'denied') return 'denied'
  if (fg?.status === 'granted') return 'when_in_use'
  return 'undetermined'
}

export default function LocationGate() {
  const { session, impersonatingFrom } = useAuth()
  // null = unknown (render nothing — never block on a fetch failure);
  // {required, gate_copy} once the config has loaded.
  const [config, setConfig] = useState(null)
  const [granted, setGranted] = useState(null)
  const [denied, setDenied] = useState(false) // permanently denied → Settings
  // GEO-ATT.17 — a paired studio kiosk is never gated. A shared reception
  // iPad won't have "Always" location, so without this the gate would
  // block the kiosk out of the app entirely. syncGeofences applies the
  // same carve-out, so a kiosk never registers regions either.
  const [isKiosk, setIsKiosk] = useState(false)

  // STAFF-DEV.7 — last value we told the server, so a foreground that
  // changed nothing costs no round-trip. `check` runs on EVERY
  // foreground, and reporting an unchanged permission every time would
  // hammer the endpoint for no new information.
  const reportedRef = useRef(null)
  // Read through refs, not closure: `check` is memoised with an empty
  // dep list and captured by a long-lived AppState listener, so a
  // sign-out or an impersonation started afterwards must still be seen.
  const sessionRef = useRef(session)
  const impersonatingRef = useRef(impersonatingFrom)
  useEffect(() => {
    sessionRef.current = session
    impersonatingRef.current = impersonatingFrom
  }, [session, impersonatingFrom])

  const check = useCallback(async () => {
    let bg = null
    try {
      bg = await Location.getBackgroundPermissionsAsync()
      setGranted(bg.status === 'granted')
      setDenied(bg.status === 'denied' && !bg.canAskAgain)
    } catch { setGranted(true) } // never brick the app on a permission API error

    // Fire-and-forget device-state report. Mirrors the gate's own
    // early-outs — but these are a CHEAP EARLY-OUT ONLY: the
    // authoritative impersonation guard lives inside reportDeviceState,
    // which reads SecureStore. `impersonatingFrom` here comes from a
    // fire-and-forget /api/mobile/me refresh that lands AFTER
    // setSession, so on a cold start it is still null while api() is
    // already attaching x-impersonate-target. Wrapped in its own
    // try/catch so a reporting failure can never block or break the gate.
    try {
      if (!bg) return
      if (!sessionRef.current || impersonatingRef.current) return
      let fg = null
      try { fg = await Location.getForegroundPermissionsAsync() } catch { /* background alone is enough */ }
      const value = mapPermission(bg, fg)
      if (value === reportedRef.current) return
      // Only remember it once the SERVER confirmed it. api() never
      // throws and never sets `skipped` — a network failure comes back
      // as { success: false, error: '…' } — so anything short of an
      // explicit success must be retried on the next foreground rather
      // than silently written off. The upsert is idempotent, so a rare
      // double-report costs nothing.
      const res = await reportDeviceState({ geofencePermission: value })
      if (res?.result?.success) reportedRef.current = value
    } catch { /* reporting is best-effort — never surfaces to the user */ }
  }, [])

  useEffect(() => {
    if (!session) return
    api('/api/attendance/geofence-config').then(r => {
      if (r.success && r.data) setConfig(r.data)
    })
    check()
    const sub = AppState.addEventListener('change', (s) => {
      // GEO-ATT.10b — refresh the gate's config from the sync result so
      // an operator toggling geofencing / exemption propagates on the
      // next foreground without a remount.
      if (s === 'active') { check(); syncGeofences().then(d => { if (d) setConfig(d) }) }
    })
    return () => sub.remove()
  }, [session, check])

  // Once granted, make sure regions are registered.
  useEffect(() => { if (granted && config?.required) syncGeofences() }, [granted, config])

  // GEO-ATT.17 — resolve kiosk pairing once on mount. Pairing only
  // changes via a deliberate pair/unpair action (which restarts the
  // session), so there is nothing to subscribe to here.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { getPairing } = await import('../lib/studio-device')
        const paired = await getPairing()
        if (alive) setIsKiosk(!!paired)
      } catch { /* unreadable ⇒ treat as a normal device (still gated) */ }
    })()
    return () => { alive = false }
  }, [])

  const request = useCallback(async () => {
    try {
      const fg = await Location.requestForegroundPermissionsAsync()
      if (fg.status !== 'granted') { await check(); return }
      // Background must follow foreground. On Android 11+ this opens
      // the app's settings screen (the only place "Allow all the time"
      // can be granted); on iOS it shows the upgrade-to-Always prompt.
      await Location.requestBackgroundPermissionsAsync()
      await check()
    } catch { await check() }
  }, [check])

  // GEO-ATT.10b — never gate a master who is viewing-as a gated staff
  // member: the block would also hide the stop-impersonating UI, locking
  // the master out. The gate reflects the TARGET's requirement, not the
  // master's own; syncGeofences() separately refuses to (re)register
  // regions mid-impersonation.
  if (impersonatingFrom) return null

  if (!session) return null
  if (isKiosk) return null
  const blocked = config?.required === true && granted === false
  if (!blocked) return null

  return (
    <View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
      className="items-center justify-center bg-un1t-bg px-8"
    >
      {/* GEO-ATT.19 — headline names the FEATURE, not the requirement. Google
          Play grades this screen as the prominent disclosure for background
          location; "Location required to utilise app features" told a reviewer
          (and a staffer) nothing about what the data is for. The body below is
          server-supplied (DEFAULT_GATE_COPY) and carries the "even when the app
          is closed or not in use" clause Play looks for. */}
      <Text className="text-2xl font-bold text-un1t-text text-center mb-4">
        Automatic shift attendance needs your location
      </Text>
      <Text className="text-base text-un1t-subtle text-center mb-8">{config.gate_copy}</Text>
      <Pressable
        onPress={denied ? () => Linking.openSettings() : request}
        className="bg-un1t-text rounded-2xl px-8 py-4 items-center active:opacity-70"
      >
        <Text className="text-un1t-bg font-semibold text-base">
          {denied ? 'Open Settings' : 'Allow location access'}
        </Text>
      </Pressable>
      <Text className="text-xs text-un1t-muted text-center mt-6">
        Set location to “Always” so arrival is detected with the app closed.
      </Text>
    </View>
  )
}

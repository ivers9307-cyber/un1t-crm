// mobile/components/LocationGate.jsx
//
// GEO-ATT — hard gate (Richard, 2026-07-30): staff with geofence
// attendance enabled at any of their locations must grant background
// ("Always") location before they can use the app. Exempt staff and
// users at non-geofence locations get required=false and never see
// this. Re-checks on every foreground so returning from Settings
// unblocks without a relaunch.

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, AppState, Linking } from 'react-native'
import * as Location from 'expo-location'
import { useAuth } from '../lib/auth-context'
import { api } from '../lib/api'
import { syncGeofences } from '../lib/geofence'

export default function LocationGate({ children }) {
  const { session } = useAuth()
  // null = unknown (render children — never block on a fetch failure);
  // {required, gate_copy} once the config has loaded.
  const [config, setConfig] = useState(null)
  const [granted, setGranted] = useState(null)
  const [denied, setDenied] = useState(false) // permanently denied → Settings

  const check = useCallback(async () => {
    try {
      const bg = await Location.getBackgroundPermissionsAsync()
      setGranted(bg.status === 'granted')
      setDenied(bg.status === 'denied' && !bg.canAskAgain)
    } catch { setGranted(true) } // never brick the app on a permission API error
  }, [])

  useEffect(() => {
    if (!session) return
    api('/api/attendance/geofence-config').then(r => {
      if (r.success && r.data) setConfig(r.data)
    })
    check()
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') { check(); syncGeofences() }
    })
    return () => sub.remove()
  }, [session, check])

  // Once granted, make sure regions are registered.
  useEffect(() => { if (granted && config?.required) syncGeofences() }, [granted, config])

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

  const blocked = config?.required === true && granted === false
  if (!blocked) return children

  return (
    <View className="flex-1 items-center justify-center bg-un1t-bg px-8">
      <Text className="text-2xl font-bold text-un1t-text text-center mb-4">Location required</Text>
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

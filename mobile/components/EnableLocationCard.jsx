// mobile/components/EnableLocationCard.jsx
//
// LOC-NUDGE.1 — Home's "enable location" card: shown (by the caller, via
// shouldShowLocationNudge) only when foreground location permission is the
// one thing standing between the user and the on-site Home. Two modes:
//   'ask'      — the in-app iOS/Android prompt can still be shown; the
//                button fires requestForegroundPermissionsAsync and then
//                ALWAYS calls onChanged() — the hook re-reads the permission
//                on its next resolve, so a grant flips Home on-site
//                immediately and a hard denial flips this card to settings
//                mode without any state juggling here.
//   'settings' — permanently denied; the button deep-links to the OS
//                Settings app, and the next foreground calls onChanged() so
//                a toggle made there lands without waiting for the hook's
//                own time-away gate (a Settings round trip is usually well
//                under it).
//
// Asks for FOREGROUND ("While Using") only — the background/"Always" ask
// belongs to the attendance gate (LocationGate.jsx), whose audience never
// sees this card anyway (they granted more than it needs to get in).

import { useEffect, useRef } from 'react'
import { View, Text, Pressable, AppState, Linking } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Location from 'expo-location'

export default function EnableLocationCard({ mode, onChanged, onDismiss }) {
  const settingsPendingRef = useRef(false)

  async function enable() {
    if (mode === 'settings') {
      settingsPendingRef.current = true
      try { await Linking.openSettings() } catch { settingsPendingRef.current = false }
      return
    }
    try {
      await Location.requestForegroundPermissionsAsync()
    } catch { /* unreadable — onChanged() below re-reads and the nudge hides */ }
    onChanged?.()
  }

  // After a Settings round trip, re-resolve on the very next foreground —
  // don't rely on the hook's time-away threshold, which a quick toggle
  // legitimately stays under.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || !settingsPendingRef.current) return
      settingsPendingRef.current = false
      onChanged?.()
    })
    return () => sub.remove()
  }, [onChanged])

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-4">
      <View className="flex-row items-start">
        <View className="w-9 h-9 rounded-full items-center justify-center mr-3" style={{ backgroundColor: '#2563EB1A' }}>
          <Ionicons name="location-outline" size={18} color="#2563EB" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-un1t-text">Enable location</Text>
          <Text className="text-xs text-un1t-subtle mt-0.5">
            Home becomes your studio&apos;s remote — controls and today&apos;s roster appear
            the moment you walk in. Location is only read while you&apos;re using the app.
          </Text>
        </View>
      </View>
      <View className="flex-row items-center mt-3">
        <Pressable
          onPress={enable}
          accessibilityRole="button"
          className="bg-un1t-text rounded-xl px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm font-semibold text-un1t-bg">
            {mode === 'settings' ? 'Open Settings' : 'Enable location'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          className="px-4 py-2 ml-1 active:opacity-70"
        >
          <Text className="text-sm text-un1t-subtle">Not now</Text>
        </Pressable>
      </View>
    </View>
  )
}

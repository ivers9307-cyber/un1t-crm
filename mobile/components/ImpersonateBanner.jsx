// Pinned amber banner shown at the top of every tab while a master is
// "viewing as" another user. Mirrors the web ImpersonationBanner. Tap
// "Stop" to end the session — clears local state, calls
// /api/mobile/impersonate/stop to close the audit row, then refreshes
// /me so the master's own profile re-appears.
//
// Renders nothing when not impersonating, so it's safe to mount
// unconditionally inside the tabs layout.

import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useState } from 'react'
import { useAuth } from '../lib/auth-context'

export default function ImpersonateBanner() {
  const { impersonatingFrom, profile, stopImpersonation } = useAuth()
  const [stopping, setStopping] = useState(false)

  if (!impersonatingFrom) return null

  async function handleStop() {
    if (stopping) return
    setStopping(true)
    try {
      await stopImpersonation()
    } finally {
      setStopping(false)
    }
  }

  return (
    // SafeAreaView pushes the banner below the iOS status bar / Dynamic
    // Island. We only consume the top edge — the navigator below us
    // claims the rest of the safe area itself.
    <SafeAreaView edges={['top']} style={{ backgroundColor: '#F59E0B' }}>
      <View className="px-4 py-2 flex-row items-center">
        <Ionicons name="eye-outline" size={16} color="#000" />
        <View className="flex-1 ml-2">
          <Text className="text-xs font-semibold text-black" numberOfLines={1}>
            Viewing as {profile?.full_name || 'user'}
          </Text>
          <Text className="text-[10px] text-black/70" numberOfLines={1}>
            Logged in as {impersonatingFrom.masterName || impersonatingFrom.masterEmail || 'master'}
          </Text>
        </View>
        <Pressable
          onPress={handleStop}
          disabled={stopping}
          className="bg-black/80 active:opacity-80 px-3 py-1.5 rounded-md"
        >
          {stopping ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text className="text-xs font-semibold text-white">Stop</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

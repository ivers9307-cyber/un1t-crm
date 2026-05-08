// Pinned amber banner shown at the top of the tabs while the
// signed-in user has unsigned contracts. Mirrors the web
// PendingContractsAlert (banner half — there's no modal on
// mobile because the staff app launch is the implicit "open"
// moment; if there's a contract waiting, the banner is the
// first thing they see).
//
// Returns null when there's nothing pending OR when the user is
// already on a /contracts route — the latter avoids shouting
// at someone who's mid-sign.

import { View, Text, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname, useFocusEffect } from 'expo-router'
import { useAuth } from '../lib/auth-context'
import { listPendingContracts } from '../lib/contracts-api'

export default function PendingContractsBanner() {
  const router = useRouter()
  const pathname = usePathname()
  const { profile } = useAuth()
  const [pending, setPending] = useState([])

  const refresh = useCallback(async () => {
    if (!profile) {
      setPending([])
      return
    }
    const res = await listPendingContracts()
    setPending(res?.success ? (res.data || []) : [])
  }, [profile])

  // Refresh on every focus — visiting any tab re-checks. Cheap
  // round-trip; the API only counts/lists this user's pending
  // contracts.
  useFocusEffect(useCallback(() => {
    refresh()
  }, [refresh]))

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!profile) return null
  if (pending.length === 0) return null
  // Hide on the contracts subtree itself — the user is already
  // there; the banner would just be visual noise.
  if (pathname?.startsWith('/contracts')) return null

  const top = pending[0]
  const count = pending.length

  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: '#F59E0B' }}>
      <Pressable
        onPress={() => router.push(`/contracts/${top.id}`)}
        className="px-4 py-2 flex-row items-center"
      >
        <Ionicons name="document-text-outline" size={16} color="#000" />
        <View className="flex-1 ml-2">
          <Text className="text-xs font-semibold text-black" numberOfLines={1}>
            {count === 1
              ? 'You have a contract awaiting your signature'
              : `${count} contracts awaiting your signature`}
          </Text>
          <Text className="text-[10px] text-black/70" numberOfLines={1}>
            {top.template_name} — tap to sign
          </Text>
        </View>
        <View className="ml-2 px-2.5 py-1 rounded-md bg-black">
          <Text className="text-[11px] font-semibold text-white">Sign</Text>
        </View>
      </Pressable>
    </SafeAreaView>
  )
}

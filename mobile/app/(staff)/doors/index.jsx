// STUDIO-HUB.1 — standalone Door unlock screen.
//
// Was a card stacked inside the Studio Management tab; now its own
// sub-screen under the Studio hub. Two-stage arm→fire unlock per door
// (matches the web + UniFi mobile UX). Gated by studio_management;
// re-fetches the door list on focus + whenever the effective identity
// or location changes (impersonation-safe — see #364).

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Alert,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../../lib/auth-context'
import { canMobile } from '../../../lib/permissions'
import { listDoors, unlockDoor } from '../../../lib/studio-mgmt-api'

export default function DoorsScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const allowed = canMobile(profile, 'studio_management', activeLocation)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const scopeKey = `${profile?.id || 'anon'}:${activeLocation?.id || 'none'}:${refreshKey}`

  function onRefresh() {
    setRefreshing(true)
    setRefreshKey(k => k + 1)
    setTimeout(() => setRefreshing(false), 600)
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-un1t-bg items-center justify-center p-6">
        <Text className="text-sm text-un1t-subtle text-center">
          Studio Management isn&apos;t enabled for your role at this location.
        </Text>
        <Pressable onPress={() => router.back()} className="mt-4">
          <Text className="text-sm text-blue-600">Back</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      <Text className="text-sm text-un1t-subtle mb-4">
        Unlock doors at {activeLocation?.name || 'your active location'}.
      </Text>
      <DoorsCard key={`doors-${scopeKey}`} locationId={activeLocation?.id} />
    </ScrollView>
  )
}

function DoorsCard({ locationId }) {
  const [doors, setDoors] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    if (!locationId) return
    setLoading(true)
    listDoors(locationId).then(r => {
      if (r.code === 'unifi_not_configured' || (!r.success && /not.*configured/i.test(r.error || ''))) {
        setDoors([])
        setError(r.error || 'UniFi not configured for this location.')
      } else if (!r.success) {
        setError(r.error || 'Failed to load doors')
        setDoors([])
      } else {
        setError(null)
        setDoors(r.data || [])
      }
    }).finally(() => setLoading(false))
  }, [locationId])

  useEffect(() => { load() }, [load])
  useFocusEffect(useCallback(() => { load() }, [load]))

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      <View className="flex-row items-center mb-3">
        <Ionicons name="key-outline" size={18} color="#A855F7" />
        <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">Door unlock</Text>
      </View>
      {loading ? (
        <ActivityIndicator color="#94A3B8" />
      ) : error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <Text className="text-sm text-red-700">{error}</Text>
        </View>
      ) : doors.length === 0 ? (
        <Text className="text-sm text-un1t-subtle">No doors configured at this studio.</Text>
      ) : (
        doors.map((door, i) => (
          <DoorRow key={door.id} door={door} locationId={locationId} isLast={i === doors.length - 1} />
        ))
      )}
    </View>
  )
}

// Two-stage unlock: first tap "arms" the button (3-second window),
// second tap fires.
function DoorRow({ door, locationId, isLast }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unlockedAt, setUnlockedAt] = useState(null)
  const armTimer = useRef(null)
  const fadeTimer = useRef(null)

  function arm() {
    if (busy) return
    setArmed(true)
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => setArmed(false), 3000)
  }

  async function fire() {
    clearTimeout(armTimer.current)
    setArmed(false)
    setBusy(true)
    const r = await unlockDoor(door.id, locationId)
    setBusy(false)
    if (r.success) {
      setUnlockedAt(Date.now())
      clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => setUnlockedAt(null), 5000)
    } else {
      Alert.alert('Unlock failed', r.error || 'Unknown error')
    }
  }

  useEffect(() => () => {
    clearTimeout(armTimer.current)
    clearTimeout(fadeTimer.current)
  }, [])

  return (
    <Pressable
      onPress={armed ? fire : arm}
      disabled={busy}
      className={`flex-row items-center px-1 py-3.5 active:opacity-70 ${!isLast ? 'border-b border-un1t-border' : ''}`}
    >
      <Ionicons
        name={armed ? 'lock-open' : 'lock-closed-outline'}
        size={20}
        color={armed ? '#A855F7' : '#94A3B8'}
      />
      <View className="flex-1 ml-3">
        <Text className="text-base font-semibold text-un1t-text">{door.name}</Text>
        {unlockedAt && !armed && !busy && (
          <Text className="text-xs text-green-600 mt-0.5">Unlocked just now</Text>
        )}
        {armed && (
          <Text className="text-xs text-purple-700 font-medium mt-0.5">
            Tap again within 3s to unlock
          </Text>
        )}
      </View>
      {busy
        ? <ActivityIndicator color="#94A3B8" />
        : armed
          ? <Ionicons name="arrow-forward-circle" size={22} color="#A855F7" />
          : <Ionicons name="chevron-forward" size={16} color="#94A3B8" />}
    </Pressable>
  )
}

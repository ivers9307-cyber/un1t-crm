// Studio Management tab — AC control + door unlock for staff at the active
// location. Permission: studio_management (cross-platform key, mig 093). Web has
// the same surface at /studio-management.
//
// MOBILE-AC.2 — the AC section now renders the unified multi-device list
// (components/AcDeviceList.jsx: Sensibo gym floor + LG ThinQ units, grouped),
// the same list as the web AcControlPanel and the /ac screen. Replaces the old
// single-Sensibo card so all AC units live here alongside Doors.

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View, Text, ScrollView, Pressable, RefreshControl,
  ActivityIndicator, Alert,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listDoors, unlockDoor } from '../../lib/studio-mgmt-api'
import AcDeviceList from '../../components/AcDeviceList'

export default function StudioManagementScreen() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()

  // Permission gate — defence in depth. The tab won't show unless permitted,
  // but a hand-typed deep-link bypass would otherwise reach the page.
  if (!canMobile(profile, 'studio_management', activeLocation)) {
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

  const [refreshing, setRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  async function onRefresh() {
    setRefreshing(true)
    // Children re-fetch via their own focus/load effects when keys change.
    // Bumping refreshKey forces remount so they refetch.
    setRefreshKey(k => k + 1)
    setTimeout(() => setRefreshing(false), 600)
  }

  // Remount the cards whenever the *effective identity* or location changes —
  // not just on manual refresh. profile.id flips to the impersonated user when
  // a "View as user" session starts (and back when it stops), so keying on it
  // forces a fresh, correctly-scoped fetch the instant impersonation toggles.
  const scopeKey = `${profile?.id || 'anon'}:${activeLocation?.id || 'none'}:${refreshKey}`

  return (
    <ScrollView
      className="flex-1 bg-un1t-bg"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#94A3B8" />}
    >
      <Text className="text-sm text-un1t-subtle mb-4">
        On-site actions for {activeLocation?.name || 'your active location'}.
      </Text>

      {/* Air conditioning — unified list (Sensibo + LG ThinQ), grouped. */}
      <View className="flex-row items-center mb-3">
        <Ionicons name="snow-outline" size={18} color="#2563EB" />
        <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">Air conditioning</Text>
      </View>
      <AcDeviceList key={`ac-${scopeKey}`} locationId={activeLocation?.id} />

      <View className="h-6" />

      <DoorsCard key={`doors-${scopeKey}`} locationId={activeLocation?.id} />
    </ScrollView>
  )
}

// ── Doors card ────────────────────────────────────────────────────

function DoorsCard({ locationId }) {
  const [doors, setDoors] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // The door list is server-scoped to whoever getCurrentUser() resolves to —
  // during a "View as user" session that's the impersonated user, so it must
  // re-fetch whenever the effective identity changes, not only on location
  // change. (Previously a plain useEffect([locationId]) left a stale operator
  // list on screen after impersonation started without a location switch.)
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
  // Re-fetch on every tab focus — matches AcDeviceList and picks up an
  // allowlist that changed while the user was on another screen (e.g. just
  // started/stopped "View as user" from the More tab).
  useFocusEffect(useCallback(() => { load() }, [load]))

  return (
    <Card>
      <Header label="Door unlock" icon="key-outline" tint="#A855F7" />
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
          <DoorRow
            key={door.id}
            door={door}
            locationId={locationId}
            isLast={i === doors.length - 1}
          />
        ))
      )}
    </Card>
  )
}

// Two-stage unlock: first tap "arms" the button (3-second window), second tap
// fires. Matches the web pattern + UniFi mobile UX.
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

// ── Shared ────────────────────────────────────────────────────────

function Card({ children }) {
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-5">
      {children}
    </View>
  )
}
function Header({ label, icon, tint }) {
  return (
    <View className="flex-row items-center mb-3">
      <Ionicons name={icon} size={18} color={tint} />
      <Text className="text-xs font-bold text-un1t-text uppercase tracking-wider ml-2">{label}</Text>
    </View>
  )
}

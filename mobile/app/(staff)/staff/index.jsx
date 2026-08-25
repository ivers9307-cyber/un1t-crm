// STAFF-C1 — mobile staff directory (read). Admin-gated (master/owner/
// manager). Lists staff sharing a location with the caller via the SDK;
// a row opens the detail (view + edit role/details). Compact two-line
// rows: name + role on the first line, studios muted below.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Pressable } from 'react-native'
import { Stack, useRouter, useFocusEffect } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { formatRole } from '../../../lib/staff-format'
import { canMobile } from '../../../lib/permissions'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function locationsLabel(staff) {
  const names = (staff.profile_locations || [])
    .map(pl => pl.locations?.name)
    .filter(Boolean)
  return names.length ? names.join(', ') : '—'
}

export default function StaffDirectory() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  // Surface visibility — gated by the staff_management mobile permission
  // (STAFF-C3 parity inversion), defaulting to master/owner/manager.
  const isAdmin = canMobile(profile, 'staff_management', activeLocation)
  // Create is owner-at-active / master only (matches POST /api/staff) —
  // narrower than the directory-view gate, so a manager sees the list but
  // not the "Add" action.
  const canCreate = !!profile && (profile.isMaster || profile.role === 'owner')

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.list()
    if (!res.success) { setError(res.error || 'Failed to load staff'); setRows([]); return }
    setRows(res.data || [])
  }, [])

  // Load on mount AND silently refetch on every focus, so a member just
  // created (or edited) shows up when returning to the list. The spinner
  // only appears on the first load while `loading` is still true; on
  // re-focus `loading` is already false, so the current rows stay on
  // screen until the fresh data lands (the fresh-on-focus convention).
  useFocusEffect(
    useCallback(() => {
      if (!isAdmin) { setLoading(false); return }
      load().finally(() => setLoading(false))
    }, [isAdmin, load])
  )

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Staff',
          headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" />,
          headerRight: () => (isAdmin && canCreate
            ? <Pressable onPress={() => router.push('/staff/new')} hitSlop={8}><Text className="text-un1t-accent font-semibold">Add</Text></Pressable>
            : null),
        }}
      />

      {!isAdmin ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Staff management is owner/manager only.</Text>
        </View>
      ) : loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 pt-4 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} tintColor="#111827" />}
        >
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}
          {rows.length === 0 ? (
            <Text className="text-center text-un1t-subtle py-8">No staff at your studios yet.</Text>
          ) : (
            rows.map((staff) => (
              <Pressable
                key={staff.id}
                onPress={() => router.push(`/staff/${staff.id}`)}
                className="rounded-2xl border border-un1t-border bg-white px-4 py-3 mb-2 active:bg-un1t-surface"
              >
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{staff.full_name}</Text>
                  <Text className="text-xs text-un1t-subtle ml-2">{formatRole(staff.role)}</Text>
                </View>
                <Text className="text-xs text-un1t-subtle mt-0.5" numberOfLines={1}>{locationsLabel(staff)}</Text>
              </Pressable>
            ))
          )}
          <Text className="text-xs text-un1t-muted text-center mt-4 px-4">
            Tap a staff member to view their details, edit roles, or send a password reset.
          </Text>
        </ScrollView>
      )}
    </View>
  )
}

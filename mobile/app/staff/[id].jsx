// STAFF-C1 — mobile staff detail (read-only). Loads one staff member
// via the SDK and shows their profile + per-studio assignments. No edit
// controls (C2). Admin-gated like the list.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { sdk } from '../../lib/sdk'
import { Card } from '../../components/ui'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const ADMIN_ROLES = ['master', 'owner', 'manager']

function Row({ label, value }) {
  return (
    <View className="flex-row justify-between px-4 py-3 border-b border-un1t-border">
      <Text className="text-sm text-un1t-subtle">{label}</Text>
      <Text className="text-sm text-un1t-text">{value ?? '—'}</Text>
    </View>
  )
}

export default function StaffDetail() {
  const { id } = useLocalSearchParams()
  const { profile } = useAuth()
  const isAdmin = !!profile && ADMIN_ROLES.includes(profile.role)

  const [staff, setStaff] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); setStaff(null); return }
    setStaff(res.data)
  }, [id])

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [isAdmin, load])

  const assignments = staff?.profile_locations || []

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: staff?.full_name || 'Staff', headerLeft: () => <BackHeaderLeft label="Staff" fallbackHref="/staff" /> }} />

      {!isAdmin ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
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
          {staff && (
            <>
              <Card padding="none" className="overflow-hidden mb-4">
                <Row label="Name" value={staff.full_name} />
                <Row label="Email" value={staff.email} />
                <Row label="Role" value={staff.role} />
                <Row label="Status" value={staff.active ? 'Active' : 'Inactive'} />
                <Row label="Employment" value={staff.employment_type} />
              </Card>

              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Studio assignments</Text>
              <Card padding="none" className="overflow-hidden">
                {assignments.length === 0
                  ? <Text className="text-center text-un1t-subtle py-6">No studio assignments.</Text>
                  : assignments.map((pl, i) => (
                      <View key={pl.location_id || i} className={`px-4 py-3 ${i < assignments.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                        <Text className="text-sm text-un1t-text">{pl.locations?.name || pl.location_id}</Text>
                        <Text className="text-xs text-un1t-subtle mt-0.5">{pl.role}{pl.is_default ? ' · default' : ''}</Text>
                      </View>
                    ))}
              </Card>

              <Text className="text-xs text-un1t-muted text-center mt-4 px-4">
                Read-only. Edit this staff member on the web.
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}

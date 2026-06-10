// STAFF-C1 — mobile staff directory (read). Admin-gated (master/owner/
// manager). Lists staff sharing a location with the caller via the SDK,
// rendered through the responsive DataTable primitive; a row opens the
// read-only detail. Management (edit/permissions/door access) stays on
// web until C2/C3.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useAuth } from '../../lib/auth-context'
import { sdk } from '../../lib/sdk'
import { DataTable } from '../../components/ui'
import BackHeaderLeft from '../../components/BackHeaderLeft'

const ADMIN_ROLES = ['master', 'owner', 'manager']

function locationsLabel(staff) {
  const names = (staff.profile_locations || [])
    .map(pl => pl.locations?.name)
    .filter(Boolean)
  return names.length ? names.join(', ') : '—'
}

export default function StaffDirectory() {
  const { profile } = useAuth()
  const router = useRouter()
  const isAdmin = !!profile && ADMIN_ROLES.includes(profile.role)

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

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [isAdmin, load])

  const columns = [
    { key: 'full_name', label: 'Name', flex: 2 },
    { key: 'role', label: 'Role', flex: 1 },
    { key: 'locations', label: 'Studios', flex: 2, render: (r) => <Text className="text-sm text-un1t-text">{locationsLabel(r)}</Text> },
  ]

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Staff', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

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
          <DataTable
            columns={columns}
            data={rows}
            keyExtractor={(r) => r.id}
            onRowPress={(r) => router.push(`/staff/${r.id}`)}
            empty={<Text className="text-center text-un1t-subtle py-8">No staff at your studios yet.</Text>}
          />
          <Text className="text-xs text-un1t-muted text-center mt-4 px-4">
            Read-only directory. Edit staff, roles, permissions and door access on the web for now.
          </Text>
        </ScrollView>
      )}
    </View>
  )
}

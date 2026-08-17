// STAFF-C1 — mobile staff detail (read-only). Loads one staff member
// via the SDK and shows their profile + per-studio assignments. No edit
// controls (C2). Admin-gated like the list.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { formatRole, formatEmploymentType } from '../../../lib/staff-format'
import { Card, Button } from '../../../components/ui'
import { canMobile } from '../../../lib/permissions'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

function Row({ label, value }) {
  return (
    <View className="flex-row justify-between px-4 py-3 border-b border-un1t-border">
      <Text className="text-sm text-un1t-subtle">{label}</Text>
      <Text className="text-sm text-un1t-text">{value ?? '—'}</Text>
    </View>
  )
}

const OWNER_ROLES = ['master', 'owner']

export default function StaffDetail() {
  const params = useLocalSearchParams()
  // useLocalSearchParams returns string | string[] — a deep-link or push
  // payload with a repeated param yields an array. Normalise to the first
  // value so sdk.staff.get never receives an array (→ /api/staff/a,b → 404).
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  // Surface visibility — gated by the staff_management mobile permission
  // (STAFF-C3). Edit capability (canEdit) stays owner/master.
  const isAdmin = canMobile(profile, 'staff_management', activeLocation)
  const canEdit = !!profile && OWNER_ROLES.includes(profile.role)

  const [staff, setStaff] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [resetting, setResetting] = useState(false)
  const [resetSent, setResetSent] = useState(false)

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
      <Stack.Screen options={{ title: staff?.full_name || 'Staff', headerLeft: () => <BackHeaderLeft label="Staff" fallbackHref="/staff" />, headerRight: () => (canEdit && staff ? <Pressable onPress={() => router.push(`/staff/edit/${id}`)} hitSlop={8}><Text className="text-un1t-accent font-semibold">Edit</Text></Pressable> : null) }} />

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
                <Row label="Role" value={formatRole(staff.role)} />
                <Row label="Status" value={staff.active ? 'Active' : 'Inactive'} />
                <Row label="Employment" value={formatEmploymentType(staff.employment_type)} />
              </Card>

              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">Studio assignments</Text>
              <Card padding="none" className="overflow-hidden">
                {assignments.length === 0
                  ? <Text className="text-center text-un1t-subtle py-6">No studio assignments.</Text>
                  : assignments.map((pl, i) => (
                      <View key={pl.location_id || i} className={`px-4 py-3 ${i < assignments.length - 1 ? 'border-b border-un1t-border' : ''}`}>
                        <Text className="text-sm text-un1t-text">{pl.locations?.name || pl.location_id}</Text>
                        <Text className="text-xs text-un1t-subtle mt-0.5">{formatRole(pl.role)}{pl.is_default ? ' · default' : ''}</Text>
                      </View>
                    ))}
              </Card>

              {canEdit && (
                <View className="mt-4">
                  <Button
                    variant="secondary"
                    label="Edit roles & access"
                    onPress={() => router.push(`/staff/roles/${id}`)}
                  />
                </View>
              )}

              {canEdit && (
                <View className="mt-3">
                  <Button
                    variant="secondary"
                    label="Edit permissions"
                    onPress={() => router.push(`/staff/permissions/${id}`)}
                  />
                </View>
              )}

              {isAdmin && staff?.email && (
                <View className="mt-4">
                  <Button
                    variant="secondary"
                    label={resetSent ? 'Reset email sent' : 'Send password reset'}
                    disabled={resetSent || resetting}
                    loading={resetting}
                    onPress={async () => {
                      if (resetting || resetSent) return
                      setResetting(true)
                      setError(null)
                      const res = await sdk.staff.sendPasswordReset(id)
                      setResetting(false)
                      if (!res.success) setError(res.error || 'Could not send reset')
                      else setResetSent(true)
                    }}
                  />
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}

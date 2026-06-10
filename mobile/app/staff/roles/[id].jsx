// STAFF-C2c-i.2 — per-location role editor. Lets an owner or master
// change the role of a staff member at each location they have authority
// over. Uses the safe payload builder (mobile/lib/staff-edit.js) which
// preserves permissions + door access and only emits assignments the
// caller is authorised to mutate.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useAuth } from '../../../lib/auth-context'
import { sdk } from '../../../lib/sdk'
import { buildStaffAssignmentsPatch } from '../../../lib/staff-edit'
import { Button } from '../../../components/ui'
import BackHeaderLeft from '../../../components/BackHeaderLeft'

const ROLES = ['owner', 'manager', 'head_coach', 'staff']

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

export default function StaffRoles() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile } = useAuth()
  const router = useRouter()

  const isMaster = !!profile?.isMaster
  const ownedLocationIds = Object.entries(profile?.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)
  const canEdit = isMaster || ownedLocationIds.length > 0

  const [editable, setEditable] = useState([])   // full assignment objects the caller owns
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [roleEdits, setRoleEdits] = useState({})  // location_id → new role (only changed ones)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); return }
    const all = res.data?.profile_locations || []
    // Master can edit all assignments; owner can only edit their owned locations.
    const owned = new Set(ownedLocationIds)
    const edits = isMaster ? all : all.filter(pl => owned.has(pl.location_id))
    setEditable(edits)
    setRoleEdits({})
  }, [id, isMaster, ownedLocationIds.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canEdit) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canEdit, load])

  async function save() {
    setSaving(true)
    setError(null)
    const assignments = buildStaffAssignmentsPatch({
      isMaster,
      ownedLocationIds,
      currentAssignments: editable,
      roleEdits,
    })
    const res = await sdk.staff.update(id, { assignments })
    setSaving(false)
    if (!res.success) {
      const msg = res.error || 'Save failed'
      // Surface UniFi failure but explain the role change still saved.
      if (res.unifi_failed) {
        setError(`${msg} (Role was saved; door access sync failed — retry from the web admin.)`)
      } else {
        setError(msg)
      }
      return
    }
    router.back()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Edit roles',
          headerLeft: () => (
            <BackHeaderLeft label="Back" fallbackHref={`/staff/${id}`} />
          ),
        }}
      />

      {!canEdit ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Role editing requires owner or master access.
          </Text>
        </View>
      ) : loading ? (
        <View className="py-16 items-center">
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}

          {editable.length === 0 ? (
            <View className="py-12 items-center px-6">
              <Text className="text-sm text-un1t-subtle text-center">
                No editable studio assignments.
              </Text>
            </View>
          ) : (
            <>
              {editable.map((pl) => {
                const locationName = pl.locations?.name || pl.location_id
                const currentRole = roleEdits[pl.location_id] || pl.role
                return (
                  <View key={pl.location_id} className="mb-5">
                    <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">
                      {locationName}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {ROLES.map(role => {
                        const active = currentRole === role
                        return (
                          <Pressable
                            key={role}
                            onPress={() =>
                              setRoleEdits(prev => ({ ...prev, [pl.location_id]: role }))
                            }
                            className={`rounded-xl px-3 py-2 items-center ${
                              active
                                ? 'bg-un1t-accent'
                                : 'bg-un1t-surface border border-un1t-border'
                            }`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                          >
                            <Text
                              className={`text-sm font-medium ${
                                active ? 'text-white' : 'text-un1t-subtle'
                              }`}
                            >
                              {ROLE_LABELS[role]}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  </View>
                )
              })}

              {!isMaster && (
                <Text className="text-xs text-un1t-subtle px-1 mt-1 mb-4">
                  Other studios are managed by their owners.
                </Text>
              )}

              <View className="mt-4">
                <Button
                  label={saving ? 'Saving…' : 'Save changes'}
                  onPress={save}
                  disabled={saving}
                  loading={saving}
                />
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}

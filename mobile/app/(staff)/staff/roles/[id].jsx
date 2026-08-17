// STAFF-C2c-i / C3-wizard.2 — per-location studio-assignment manager.
// An owner (at their owned studios) or master (anywhere) can change the
// role at each studio, ADD the member to another studio, or REMOVE them
// from one. Uses the safe payload builder (mobile/lib/staff-edit.js):
// existing assignments echo their permissions + door access (only the
// role changes); a removed assignment is OMITTED so the server deletes it
// (and revokes door access); an added studio is appended at role
// defaults. The owner boundary holds in the builder AND the server.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, Alert } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useAuth } from '../../../../lib/auth-context'
import { sdk } from '../../../../lib/sdk'
import { buildStaffAssignmentsPatch } from '../../../../lib/staff-edit'
import { Button } from '../../../../components/ui'
import BackHeaderLeft from '../../../../components/BackHeaderLeft'

const ROLES = ['owner', 'manager', 'head_coach', 'staff', 'reception']
const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
  reception: 'Reception',
}

function RolePills({ value, onChange }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {ROLES.map(role => {
        const active = value === role
        return (
          <Pressable
            key={role}
            onPress={() => onChange(role)}
            className={`rounded-xl px-3 py-2 items-center ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>{ROLE_LABELS[role]}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export default function StaffRoles() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile, locations } = useAuth()
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
  const [removed, setRemoved] = useState({})       // location_id → true (staged removals)
  const [added, setAdded] = useState([])           // [{ location_id, name, role }]

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
    setRemoved({})
    setAdded([])
  }, [id, isMaster, ownedLocationIds.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canEdit) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canEdit, load])

  // Studios the caller can ADD this member to: locations the caller can
  // assign at (master: all; owner: owned), minus ones already assigned or
  // already staged for add. Names come from useAuth().locations.
  const addableLocations = useMemo(() => {
    const assigned = new Set([
      ...editable.map(a => a.location_id),
      ...added.map(a => a.location_id),
    ])
    return (locations || [])
      .filter(l => isMaster || ownedLocationIds.includes(l.id))
      .filter(l => !assigned.has(l.id))
  }, [locations, editable, added, isMaster, ownedLocationIds.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  function addStudio(loc) {
    setAdded(prev => [...prev, { location_id: loc.id, name: loc.name, role: 'staff' }])
  }
  function cancelAdd(locId) {
    setAdded(prev => prev.filter(a => a.location_id !== locId))
  }
  function setAddedRole(locId, role) {
    setAdded(prev => prev.map(a => (a.location_id === locId ? { ...a, role } : a)))
  }

  const removedIds = Object.keys(removed).filter(k => removed[k])
  const dirty = Object.keys(roleEdits).length > 0 || removedIds.length > 0 || added.length > 0

  async function doSave() {
    setSaving(true)
    setError(null)
    const assignments = buildStaffAssignmentsPatch({
      isMaster,
      ownedLocationIds,
      currentAssignments: editable,
      roleEdits,
      removedLocationIds: removedIds,
      addedAssignments: added.map(a => ({ location_id: a.location_id, role: a.role })),
    })
    const res = await sdk.staff.update(id, { assignments })
    setSaving(false)
    if (!res.success) {
      const msg = res.error || 'Save failed'
      setError(res.unifi_failed
        ? `${msg} (Saved; door access sync failed — retry from the web admin.)`
        : msg)
      return
    }
    router.back()
  }

  function save() {
    if (removedIds.length > 0) {
      const names = editable
        .filter(a => removed[a.location_id])
        .map(a => a.locations?.name || a.location_id)
      Alert.alert(
        'Remove from studio?',
        `This removes the member from ${names.join(', ')} and revokes their door access there. This can't be undone from here.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: doSave },
        ]
      )
      return
    }
    doSave()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Studios & roles',
          headerLeft: () => (
            <BackHeaderLeft label="Back" fallbackHref={`/staff/${id}`} />
          ),
        }}
      />

      {!canEdit ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Editing assignments requires owner or master access.
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

          {editable.length === 0 && added.length === 0 ? (
            <View className="py-8 items-center px-6">
              <Text className="text-sm text-un1t-subtle text-center">
                No editable studio assignments yet.
              </Text>
            </View>
          ) : (
            <>
              {editable.map((pl) => {
                const locationName = pl.locations?.name || pl.location_id
                const isRemoved = !!removed[pl.location_id]
                const currentRole = roleEdits[pl.location_id] || pl.role
                return (
                  <View key={pl.location_id} className="mb-5">
                    <View className="flex-row items-center justify-between px-1 mb-2">
                      <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
                        {locationName}
                      </Text>
                      {isRemoved ? (
                        <Pressable onPress={() => setRemoved(prev => ({ ...prev, [pl.location_id]: false }))} accessibilityRole="button">
                          <Text className="text-xs font-semibold text-un1t-accent">Undo</Text>
                        </Pressable>
                      ) : (
                        <Pressable onPress={() => setRemoved(prev => ({ ...prev, [pl.location_id]: true }))} accessibilityRole="button">
                          <Text className="text-xs font-semibold text-red-600">Remove</Text>
                        </Pressable>
                      )}
                    </View>
                    {isRemoved ? (
                      <View className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2">
                        <Text className="text-xs text-red-600">Will be removed on save — door access revoked.</Text>
                      </View>
                    ) : (
                      <RolePills value={currentRole} onChange={(role) => setRoleEdits(prev => ({ ...prev, [pl.location_id]: role }))} />
                    )}
                  </View>
                )
              })}

              {added.map((a) => (
                <View key={`add-${a.location_id}`} className="mb-5">
                  <View className="flex-row items-center justify-between px-1 mb-2">
                    <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
                      {a.name} <Text className="text-emerald-600">· New</Text>
                    </Text>
                    <Pressable onPress={() => cancelAdd(a.location_id)} accessibilityRole="button">
                      <Text className="text-xs font-semibold text-un1t-subtle">Cancel</Text>
                    </Pressable>
                  </View>
                  <RolePills value={a.role} onChange={(role) => setAddedRole(a.location_id, role)} />
                </View>
              ))}
            </>
          )}

          {addableLocations.length > 0 && (
            <View className="mb-5">
              <Text className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle px-1 mb-2">
                Add to another studio
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {addableLocations.map(loc => (
                  <Pressable
                    key={loc.id}
                    onPress={() => addStudio(loc)}
                    className="rounded-xl px-3 py-2 bg-un1t-surface border border-un1t-border flex-row items-center"
                    accessibilityRole="button"
                  >
                    <Text className="text-sm font-medium text-un1t-text">+ {loc.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {!isMaster && (
            <Text className="text-xs text-un1t-subtle px-1 mt-1 mb-4">
              Other studios are managed by their owners.
            </Text>
          )}

          <View className="mt-4">
            <Button
              label={saving ? 'Saving…' : 'Save changes'}
              onPress={save}
              disabled={saving || !dirty}
              loading={saving}
            />
          </View>
        </ScrollView>
      )}
    </View>
  )
}

// STAFF-C2c-ii — per-location permissions editor. Lets an owner (at their
// owned locations) or a master (anywhere) toggle a staff member's
// permission set per location: Mobile features, Web access, and
// Notifications. Mirrors the web StaffForm permissions matrix.
//
// Correctness: hydratePermissions() renders truthful toggle state (an
// absent key shows its role-default effective value, never a silent
// "off"). buildStaffAssignmentsPatch() builds a safe payload — role +
// door access + is_default are echoed unchanged, and only *touched*
// locations carry a full edited blob, so untouched assignments are
// neither wiped nor frozen.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, Switch } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useAuth } from '../../../../lib/auth-context'
import { sdk } from '../../../../lib/sdk'
import { buildStaffAssignmentsPatch, hydratePermissions } from '../../../../lib/staff-edit'
import { Button } from '../../../../components/ui'
import BackHeaderLeft from '../../../../components/BackHeaderLeft'
import { WEB_PERMISSIONS, MOBILE_PERMISSIONS } from 'shared/permissions'

// Categories derived from the shared model — never hardcode the keys, so a
// new permission flows here automatically. Web keys live top-level on the
// blob; mobile + notification keys live under `.mobile`. The push master
// switch heads the Alerts group (it gates every notify_* below it).
const MOBILE_ITEMS = MOBILE_PERMISSIONS.filter(p => !p.isNotify && p.key !== 'push_notifications')
const ALERT_ITEMS = [
  ...MOBILE_PERMISSIONS.filter(p => p.key === 'push_notifications'),
  ...MOBILE_PERMISSIONS.filter(p => p.isNotify),
]
const CATEGORIES = [
  { id: 'mobile', label: 'Mobile', scope: 'mobile', items: MOBILE_ITEMS },
  { id: 'web', label: 'Web', scope: 'web', items: WEB_PERMISSIONS },
  { id: 'alerts', label: 'Alerts', scope: 'mobile', items: ALERT_ITEMS },
]

export default function StaffPermissions() {
  const params = useLocalSearchParams()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  const { profile } = useAuth()
  const router = useRouter()

  const isMaster = !!profile?.isMaster
  const ownedLocationIds = useMemo(
    () => Object.entries(profile?.rolesByLocation || {})
      .filter(([, r]) => r === 'owner')
      .map(([loc]) => loc),
    [profile]
  )
  const canEdit = isMaster || ownedLocationIds.length > 0

  const [editable, setEditable] = useState([])      // assignments the caller may edit
  // PERM-AUDIT.3 — role templates (mig 364) from the staff GET payload,
  // { [location_id]: { [role]: sparse blob } }. Hydration merges them
  // under stored values so sparse per-user blobs render the TRUE
  // effective state (code defaults + template + overrides).
  const [roleTemplates, setRoleTemplates] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState('mobile')
  const [permEdits, setPermEdits] = useState({})    // location_id → full edited blob (touched only)

  const load = useCallback(async () => {
    setError(null)
    const res = await sdk.staff.get(id)
    if (!res.success) { setError(res.error || 'Failed to load'); return }
    const all = res.data?.profile_locations || []
    const owned = new Set(ownedLocationIds)
    const edits = isMaster ? all : all.filter(pl => owned.has(pl.location_id))
    setEditable(edits)
    setRoleTemplates(res.data?.role_templates || {})
    setPermEdits({})
    setSelectedLocationId(prev =>
      edits.some(e => e.location_id === prev) ? prev : (edits[0]?.location_id || null)
    )
  }, [id, isMaster, ownedLocationIds])

  useEffect(() => {
    if (!canEdit) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canEdit, load])

  const selectedAssignment = editable.find(pl => pl.location_id === selectedLocationId) || null
  const category = CATEGORIES.find(c => c.id === selectedCategory) || CATEGORIES[0]

  // The working blob for the selected location — the edited one if touched,
  // else the hydrated current state so toggles render the truthful value.
  const templateFor = useCallback(
    (locId, role) => roleTemplates?.[locId]?.[role] || null,
    [roleTemplates]
  )

  const workingPerms = useMemo(() => {
    if (!selectedAssignment) return null
    return permEdits[selectedLocationId]
      || hydratePermissions(
        selectedAssignment.permissions,
        selectedAssignment.role,
        templateFor(selectedAssignment.location_id, selectedAssignment.role)
      )
  }, [selectedAssignment, selectedLocationId, permEdits, templateFor])

  function valueOf(scope, key) {
    if (!workingPerms) return false
    return scope === 'web'
      ? !!workingPerms[key]
      : !!(workingPerms.mobile && workingPerms.mobile[key])
  }

  function toggleKey(scope, key) {
    if (!selectedAssignment) return
    setPermEdits(prev => {
      const base = prev[selectedLocationId]
        || hydratePermissions(
          selectedAssignment.permissions,
          selectedAssignment.role,
          templateFor(selectedAssignment.location_id, selectedAssignment.role)
        )
      if (scope === 'web') {
        return { ...prev, [selectedLocationId]: { ...base, [key]: !base[key] } }
      }
      const mob = { ...(base.mobile || {}) }
      mob[key] = !mob[key]
      return { ...prev, [selectedLocationId]: { ...base, mobile: mob } }
    })
  }

  function setAll(value) {
    if (!selectedAssignment) return
    setPermEdits(prev => {
      const base = prev[selectedLocationId]
        || hydratePermissions(
          selectedAssignment.permissions,
          selectedAssignment.role,
          templateFor(selectedAssignment.location_id, selectedAssignment.role)
        )
      if (category.scope === 'web') {
        const patch = {}
        category.items.forEach(it => { patch[it.key] = value })
        return { ...prev, [selectedLocationId]: { ...base, ...patch } }
      }
      const mob = { ...(base.mobile || {}) }
      category.items.forEach(it => { mob[it.key] = value })
      return { ...prev, [selectedLocationId]: { ...base, mobile: mob } }
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    const assignments = buildStaffAssignmentsPatch({
      isMaster,
      ownedLocationIds,
      currentAssignments: editable,
      roleEdits: {},
      permissionEdits: permEdits,
    })
    const res = await sdk.staff.update(id, { assignments })
    setSaving(false)
    if (!res.success) {
      setError(res.unifi_failed
        ? `${res.error || 'Save failed'} (Permissions saved; door access sync failed — retry from the web admin.)`
        : (res.error || 'Save failed'))
      return
    }
    router.back()
  }

  const dirty = Object.keys(permEdits).length > 0
  const onCount = category.items.filter(it => valueOf(category.scope, it.key)).length

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen
        options={{
          title: 'Edit permissions',
          headerLeft: () => <BackHeaderLeft label="Back" fallbackHref={`/staff/${id}`} />,
        }}
      />

      {!canEdit ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">
            Editing permissions requires owner or master access.
          </Text>
        </View>
      ) : loading ? (
        <View className="py-16 items-center"><ActivityIndicator /></View>
      ) : editable.length === 0 ? (
        <View className="py-12 items-center px-6">
          <Text className="text-sm text-un1t-subtle text-center">
            No editable studio assignments.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerClassName="px-4 pt-4 pb-10">
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}

          {/* Location selector — only when the caller can edit more than one. */}
          {editable.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3 -mx-1">
              <View className="flex-row gap-2 px-1">
                {editable.map((pl) => {
                  const active = pl.location_id === selectedLocationId
                  return (
                    <Pressable
                      key={pl.location_id}
                      onPress={() => setSelectedLocationId(pl.location_id)}
                      className={`rounded-xl px-3 py-2 ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>
                        {pl.locations?.name || pl.location_id}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </ScrollView>
          )}

          {/* Category tabs — Mobile / Web / Alerts. */}
          <View className="flex-row gap-2 mb-3">
            {CATEGORIES.map((c) => {
              const active = c.id === selectedCategory
              return (
                <Pressable
                  key={c.id}
                  onPress={() => setSelectedCategory(c.id)}
                  className={`flex-1 rounded-xl px-3 py-2 items-center ${active ? 'bg-un1t-accent' : 'bg-un1t-surface border border-un1t-border'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-un1t-subtle'}`}>
                    {c.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          {/* Bulk row + on-count. */}
          <View className="flex-row items-center justify-between px-1 mb-2">
            <Text className="text-xs text-un1t-subtle">{onCount} of {category.items.length} on</Text>
            <View className="flex-row gap-3">
              <Pressable onPress={() => setAll(true)} accessibilityRole="button">
                <Text className="text-xs font-semibold text-un1t-accent">All on</Text>
              </Pressable>
              <Pressable onPress={() => setAll(false)} accessibilityRole="button">
                <Text className="text-xs font-semibold text-un1t-subtle">All off</Text>
              </Pressable>
            </View>
          </View>

          {/* Toggle rows for the selected category. */}
          <View className="rounded-2xl border border-un1t-border bg-white overflow-hidden">
            {category.items.map((it, i) => {
              const on = valueOf(category.scope, it.key)
              return (
                <View
                  key={it.key}
                  className={`flex-row items-center justify-between px-4 py-3 ${i < category.items.length - 1 ? 'border-b border-un1t-border' : ''}`}
                >
                  <Text className="text-sm text-un1t-text flex-1 pr-3" numberOfLines={1}>{it.label}</Text>
                  <Switch
                    value={on}
                    onValueChange={() => toggleKey(category.scope, it.key)}
                    trackColor={{ false: '#E2E5E9', true: '#111827' }}
                    thumbColor="#FFFFFF"
                    ios_backgroundColor="#E2E5E9"
                  />
                </View>
              )
            })}
          </View>

          {!isMaster && (
            <Text className="text-xs text-un1t-subtle px-1 mt-3">
              Other studios are managed by their owners.
            </Text>
          )}

          <View className="mt-5">
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

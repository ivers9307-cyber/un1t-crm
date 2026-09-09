// Manager "Manage" mode body. Fetches the week's shift blocks for the active
// location and renders the selected day's editable blocks. Owns the assign and
// remove mutations and refetches on success. Time edits are delegated to the
// screen's existing AdjustSheet via the onAdjust(shiftLike) callback.
//
// ROSTER-FIX.7 — this comment used to promise "pending approvals" and "a
// collapsible approvals section". There is none and there never was: approvals
// (time-off, swaps) live on the Approvals tab. Corrected rather than built,
// because the approvals surface is not this screen's job.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, ActivityIndicator, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getScheduleBlocks, getLocationStaff, assignCoachToBlock, removeAssignment,
} from '../../lib/schedule-api'
import { effShiftStart } from '../../lib/schedule-team'
import BlockCard from './BlockCard'
import CoachPickerSheet from './CoachPickerSheet'

export default function ManageMode({ activeLocation, weekStart, weekEnd, selectedIso, selectedLabel, refreshKey, onAdjust }) {
  const locationId = activeLocation?.id
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [staff, setStaff] = useState(null) // null = not loaded
  const [staffLoading, setStaffLoading] = useState(false)
  const [pickerBlock, setPickerBlock] = useState(null)

  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const b = await getScheduleBlocks({ locationId, startDate: weekStart, endDate: weekEnd })
    if (!b.success) setError(b.error || 'Failed to load roster')
    setBlocks(b.success ? b.data || [] : [])
  }, [locationId, weekStart, weekEnd])

  // ROSTER-FIX.7h — ONE fetch, not two. A plain useEffect on [load] and a
  // useFocusEffect on [load] both fire while the screen is focused, so every
  // mount, every week page and every location switch cost two identical
  // getScheduleBlocks calls, racing each other into the same setState.
  // useFocusEffect already runs on mount when the tab is focused (and again on
  // every refocus), so it is the one that stays.
  useFocusEffect(useCallback(() => {
    // refreshKey is a bump from the screen after an adjust saves; nothing reads
    // its value, being in this dependency list IS its job.
    void refreshKey
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load, refreshKey]))

  const dayBlocks = blocks
    .filter((b) => b.block_date === selectedIso)
    .sort((a, b) => (effShiftStart(a) || a.start_time || '').localeCompare(effShiftStart(b) || b.start_time || ''))

  // ROSTER-FIX.7 — the assignable-staff pool is fetched once and cached for
  // the life of the mount, and it went stale two ways. (1) It is a PER-LOCATION
  // list (`/api/staff?fields=picker` is scoped by x-active-location), but
  // nothing cleared it on a location switch, so a manager who moved studios
  // was offered the other studio's coaches until the tab remounted — and
  // assigning one 404s at the block. (2) `active` and `profile_locations` can
  // change under the operator, and the pool is what CoachPickerSheet filters,
  // so a stale copy re-offers someone who has just been removed everywhere.
  const loadStaff = useCallback(async () => {
    if (!locationId) return
    setStaffLoading(true)
    const res = await getLocationStaff({ locationId })
    setStaffLoading(false)
    setStaff(res.success ? res.data || [] : [])
    if (!res.success) Alert.alert('Could not load staff', res.error || 'Unknown error')
  }, [locationId])

  // ROSTER-FIX.7h — close the picker with the pool. Dropping the staff list on
  // a location switch while the sheet stayed open left it mid-flight over the
  // new studio: an empty list, then a reload of coaches for a block that
  // belongs to the studio the manager just left.
  useEffect(() => { setStaff(null); setPickerBlock(null) }, [locationId])

  // Refetch only when the pool was already loaded — a manager who never opened
  // the picker should not pay for a staff call on every assign/remove.
  const refreshStaffIfLoaded = useCallback(() => {
    if (staff !== null) loadStaff()
  }, [staff, loadStaff])

  async function openPicker(block) {
    setPickerBlock(block)
    if (staff === null && !staffLoading) await loadStaff()
  }

  async function pickCoach(coach) {
    const block = pickerBlock
    setPickerBlock(null)
    if (!block) return
    setBusyId(block.id)
    const res = await assignCoachToBlock(block.id, { profileId: coach.id, locationId })
    setBusyId(null)
    if (!res.success && /capacity/i.test(res.error || '')) {
      Alert.alert('Block is full', `${block.shift_templates?.name || 'This shift'} is at capacity. Add ${coach.full_name} anyway?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Add anyway', onPress: async () => {
          setBusyId(block.id)
          const r2 = await assignCoachToBlock(block.id, { profileId: coach.id, allowOverCapacity: true, locationId })
          setBusyId(null)
          if (!r2.success) Alert.alert('Could not assign', r2.error || 'Unknown error')
          else { if (r2.warnings?.length) Alert.alert('Assigned: note', r2.warnings.join('\n')); load(); refreshStaffIfLoaded() }
        } },
      ])
      return
    }
    if (!res.success) { Alert.alert('Could not assign', res.error || 'Unknown error'); return }
    if (res.warnings?.length) Alert.alert('Assigned: note', res.warnings.join('\n'))
    load()
    refreshStaffIfLoaded()
  }

  function onCoachPress(block, assignment) {
    Alert.alert(
      assignment.profiles?.full_name || 'Coach',
      `${block.shift_templates?.name || 'Shift'} · ${block.block_date}`,
      [
        { text: 'Adjust times', onPress: () => onAdjust({
          shift_assignment_id: assignment.id,
          shift_date: block.block_date,
          start_time: block.start_time,
          end_time: block.end_time,
          shift_templates: block.shift_templates,
          start_time_override: assignment.start_time_override ?? null,
          end_time_override: assignment.end_time_override ?? null,
          partial_reason: assignment.partial_reason ?? null,
        }) },
        { text: 'Remove from shift', style: 'destructive', onPress: () => confirmRemove(block, assignment) },
        { text: 'Cancel', style: 'cancel' },
      ],
    )
  }
  function confirmRemove(block, assignment) {
    Alert.alert('Remove from shift?', `Remove ${assignment.profiles?.full_name || 'this coach'} from ${block.shift_templates?.name || 'this shift'}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        setBusyId(assignment.id)
        const res = await removeAssignment(assignment.id, { locationId })
        setBusyId(null)
        if (!res.success) Alert.alert('Could not remove', res.error || 'Unknown error')
        else { load(); refreshStaffIfLoaded() }
      } },
    ])
  }

  if (loading) return <View className="py-12 items-center"><ActivityIndicator /></View>

  return (
    <View>
      {error ? (
        <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
          <Text className="text-red-500 text-sm">{error}</Text>
        </View>
      ) : null}

      <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2 px-1">{selectedLabel}</Text>
      {dayBlocks.length === 0 ? (
        <View className="py-10 items-center">
          <Ionicons name="calendar-clear-outline" size={28} color="#94A3B8" />
          <Text className="text-sm text-un1t-subtle mt-2">No shifts scheduled for this day.</Text>
        </View>
      ) : dayBlocks.map((b) => (
        <BlockCard key={b.id} block={b} busy={busyId === b.id}
          onAddCoach={() => openPicker(b)} onCoachPress={(a) => onCoachPress(b, a)} />
      ))}

      <CoachPickerSheet visible={!!pickerBlock} block={pickerBlock} locationId={locationId}
        staff={staff} loading={staffLoading} onPick={pickCoach} onClose={() => setPickerBlock(null)} />
    </View>
  )
}

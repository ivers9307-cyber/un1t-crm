// Manager "Manage" mode body. Fetches the week's blocks + pending approvals
// for the active location, renders a collapsible approvals section + the
// selected day's editable blocks. Owns all mutations (assign/remove/approve)
// and refetches on success. Time edits are delegated to the screen's existing
// AdjustSheet via the onAdjust(shiftLike) callback.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getScheduleBlocks, getPendingTimeOff, getOpenSwaps, getLocationStaff,
  assignCoachToBlock, removeAssignment, respondToTimeOff, respondToSwap,
} from '../../lib/schedule-api'
import { effShiftStart } from '../../lib/schedule-team'
import ApprovalCard from './ApprovalCard'
import BlockCard from './BlockCard'
import CoachPickerSheet from './CoachPickerSheet'

export default function ManageMode({ activeLocation, weekStart, weekEnd, selectedIso, selectedLabel, refreshKey, onAdjust }) {
  const locationId = activeLocation?.id
  const [blocks, setBlocks] = useState([])
  const [timeOff, setTimeOff] = useState([])
  const [swaps, setSwaps] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [approvalsOpen, setApprovalsOpen] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [staff, setStaff] = useState(null) // null = not loaded
  const [staffLoading, setStaffLoading] = useState(false)
  const [pickerBlock, setPickerBlock] = useState(null)

  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const [b, t, s] = await Promise.all([
      getScheduleBlocks({ locationId, startDate: weekStart, endDate: weekEnd }),
      getPendingTimeOff({ locationId }),
      getOpenSwaps({ locationId }),
    ])
    if (!b.success) setError(b.error || 'Failed to load roster')
    setBlocks(b.success ? b.data || [] : [])
    setTimeOff(t.success ? t.data || [] : [])
    setSwaps(s.success ? s.data || [] : [])
  }, [locationId, weekStart, weekEnd])

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)) }, [load, refreshKey])
  useFocusEffect(useCallback(() => { load() }, [load]))

  const dayBlocks = blocks
    .filter((b) => b.block_date === selectedIso)
    .sort((a, b) => (effShiftStart(a) || a.start_time || '').localeCompare(effShiftStart(b) || b.start_time || ''))
  const pendingCount = timeOff.length + swaps.length

  function decideTimeOff(id, status) {
    setBusyId(id)
    respondToTimeOff(id, status, null, locationId).then((res) => {
      setBusyId(null)
      if (!res.success) Alert.alert('Could not update', res.error || 'Unknown error'); else load()
    })
  }
  function decideSwap(id, status) {
    setBusyId(id)
    respondToSwap(id, status, null, locationId).then((res) => {
      setBusyId(null)
      if (!res.success) Alert.alert('Could not update', res.error || 'Unknown error'); else load()
    })
  }

  async function openPicker(block) {
    setPickerBlock(block)
    if (staff === null && !staffLoading) {
      setStaffLoading(true)
      const res = await getLocationStaff({ locationId })
      setStaffLoading(false)
      setStaff(res.success ? res.data || [] : [])
      if (!res.success) Alert.alert('Could not load staff', res.error || 'Unknown error')
    }
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
          else { if (r2.warnings?.length) Alert.alert('Assigned — note', r2.warnings.join('\n')); load() }
        } },
      ])
      return
    }
    if (!res.success) { Alert.alert('Could not assign', res.error || 'Unknown error'); return }
    if (res.warnings?.length) Alert.alert('Assigned — note', res.warnings.join('\n'))
    load()
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
        if (!res.success) Alert.alert('Could not remove', res.error || 'Unknown error'); else load()
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

      {pendingCount > 0 && (
        <View className="mb-4">
          <Pressable onPress={() => setApprovalsOpen((o) => !o)}
            className="flex-row items-center justify-between bg-un1t-surface border border-un1t-border rounded-xl px-4 py-3">
            <Text className="text-sm font-semibold text-un1t-text">Pending approvals ({pendingCount})</Text>
            <Ionicons name={approvalsOpen ? 'chevron-up' : 'chevron-down'} size={18} color="#64748B" />
          </Pressable>
          {approvalsOpen && (
            <View className="mt-2">
              {timeOff.map((t) => (
                <ApprovalCard key={`to-${t.id}`} kind="timeoff" item={t} busy={busyId === t.id}
                  onApprove={() => decideTimeOff(t.id, 'approved')} onReject={() => decideTimeOff(t.id, 'rejected')} />
              ))}
              {swaps.map((s) => (
                <ApprovalCard key={`sw-${s.id}`} kind="swap" item={s} busy={busyId === s.id}
                  onApprove={() => decideSwap(s.id, 'approved')} onReject={() => decideSwap(s.id, 'rejected')} />
              ))}
            </View>
          )}
        </View>
      )}

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

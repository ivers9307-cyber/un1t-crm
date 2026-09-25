// Manager "Manage" mode body. Fetches the week's shift blocks for the active
// location and renders the selected day's editable blocks. Owns the assign and
// remove mutations and refetches on success. Time edits are delegated to the
// screen's existing AdjustSheet via the onAdjust(shiftLike) callback.
//
// ROSTER-FIX.7 — this comment used to promise "pending approvals" and "a
// collapsible approvals section". There is none and there never was: approvals
// (time-off, swaps) live on the Approvals tab. Corrected rather than built,
// because the approvals surface is not this screen's job.
import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, ActivityIndicator, Alert, Pressable } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  getScheduleBlocks, getLocationStaff, assignCoachToBlock, removeAssignment, replaceAssignment, getBlockCandidates,
} from '../../lib/schedule-api'
// CANDIDATES.1 — the picker's ranked list: request lifecycle (pure, tested).
import { NO_CANDIDATES, candidatesStarted, candidatesSettled, candidatesFor } from '../../lib/candidates-view'
import { effShiftStart } from '../../lib/schedule-team'
import {
  adjustTargetFor, rosterKey, rosterLoadOutcome, staffLoadOutcome, isCurrentLoad,
  coachPressActions, replacePickerTitle, replaceResultAlert,
} from '../../lib/schedule-manage'
import { dublinTodayIso } from '../../lib/dates'
import BlockCard from './BlockCard'
import CoachPickerSheet from './CoachPickerSheet'

export default function ManageMode({ activeLocation, weekStart, weekEnd, selectedIso, selectedLabel, refreshKey, onAdjust }) {
  const locationId = activeLocation?.id
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // MANAGEMODE.1 — true while a failed refresh left the last good roster of
  // THIS location+week on screen (rosterLoadOutcome decides).
  const [stale, setStale] = useState(false)
  const [canRetry, setCanRetry] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [staff, setStaff] = useState(null) // null = not loaded
  const [staffLoading, setStaffLoading] = useState(false)
  const [staffError, setStaffError] = useState(null)
  const [pickerBlock, setPickerBlock] = useState(null)
  const [replaceTarget, setReplaceTarget] = useState(null) // REPLACE.1a — { block, assignment }
  // CANDIDATES.1 — the ranked list for the block the picker is open on. One
  // ask per open; only the newest ask for the open block lands.
  const [candidates, setCandidates] = useState(NO_CANDIDATES)
  const candidatesSeq = useRef(0)

  // MANAGEMODE.1 — only the newest load may write state. Paging weeks fast, a
  // slow answer for the week just left used to land after the new week's and
  // paint it under the new dates. `loadedKey` is what `blocks` belongs to.
  const generation = useRef(0)
  const loadedKey = useRef(null)
  // MANAGEMODE.1 (review) — what is on screen NOW, read by loads that were
  // started from an older render (an assign/remove's refresh). See
  // isCurrentLoad: such a load for a key the screen has left never starts.
  const currentKey = useRef(null)
  const currentLocation = useRef(null)
  currentKey.current = locationId ? rosterKey(locationId, weekStart, weekEnd) : null
  currentLocation.current = locationId ?? null

  // The error is NOT cleared when a load starts, only when one settles, so a
  // persistent failure does not blink on every refresh (the web's rule).
  //
  // `spinner` covers the screen until THIS load settles. Only the newest load
  // clears it: a superseded one finishing first used to drop the spinner and
  // show the week just left under the new week's dates until the winner came.
  const load = useCallback(async ({ spinner = false } = {}) => {
    if (!locationId) {
      generation.current += 1 // an in-flight answer for the old studio is dropped
      setLoading(false)
      return
    }
    const requestedKey = rosterKey(locationId, weekStart, weekEnd)
    if (requestedKey !== currentKey.current) return
    const gen = ++generation.current
    if (spinner) setLoading(true)
    let res
    try {
      res = await getScheduleBlocks({ locationId, startDate: weekStart, endDate: weekEnd })
    } catch (e) {
      res = { success: false, error: e?.message }
    }
    if (!isCurrentLoad({ gen, currentGen: generation.current, requestedKey, currentKey: currentKey.current })) return
    const out = rosterLoadOutcome({ res, requestedKey, loadedKey: loadedKey.current })
    if (out.blocks !== undefined) setBlocks(out.blocks)
    loadedKey.current = out.loadedKey
    setError(out.error)
    setStale(out.stale)
    setCanRetry(out.canRetry)
    setLoading(false)
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
    load({ spinner: true })
  }, [load, refreshKey]))

  function retry() {
    load({ spinner: true })
  }

  const dayBlocks = blocks
    .filter((b) => b.block_date === selectedIso)
    .sort((a, b) => (effShiftStart(a) || '').localeCompare(effShiftStart(b) || ''))

  // ROSTER-FIX.7 — the assignable-staff pool is fetched once and cached for
  // the life of the mount, and it went stale two ways. (1) It is a PER-LOCATION
  // list (`/api/staff?fields=picker` is scoped by x-active-location), but
  // nothing cleared it on a location switch, so a manager who moved studios
  // was offered the other studio's coaches until the tab remounted — and
  // assigning one 404s at the block. (2) `active` and `profile_locations` can
  // change under the operator, and the pool is what CoachPickerSheet filters,
  // so a stale copy re-offers someone who has just been removed everywhere.
  //
  // MANAGEMODE.1 — a failed load stored `[]`: the picker said "No available
  // coaches to add." and, since openPicker only fetches while the pool is
  // null, never tried again. staffLoadOutcome keeps a failed first load null
  // (the next open, or the sheet's Try again, retries) with a reason for the
  // sheet to show; a failed refresh keeps the pool already loaded. The
  // generation drops an answer for a studio the manager has since left.
  const staffGeneration = useRef(0)
  // The pool as last written, for staffLoadOutcome's keep-on-refresh rule
  // without making loadStaff depend on (and re-create with) `staff`.
  const staffRef = useRef(null)
  const loadStaff = useCallback(async () => {
    // Same rule as load(): a refresh fired from a render for a studio the
    // manager has since left must not start, let alone write that studio's
    // coaches into this one's picker.
    if (!locationId || locationId !== currentLocation.current) return
    const gen = ++staffGeneration.current
    setStaffLoading(true)
    let res
    try {
      res = await getLocationStaff({ locationId })
    } catch (e) {
      res = { success: false, error: e?.message }
    }
    if (gen !== staffGeneration.current || locationId !== currentLocation.current) return
    setStaffLoading(false)
    const out = staffLoadOutcome({ res, current: staffRef.current })
    staffRef.current = out.staff
    setStaff(out.staff)
    setStaffError(out.error)
  }, [locationId])

  // ROSTER-FIX.7h — close the picker with the pool. Dropping the staff list on
  // a location switch while the sheet stayed open left it mid-flight over the
  // new studio: an empty list, then a reload of coaches for a block that
  // belongs to the studio the manager just left.
  useEffect(() => {
    candidatesSeq.current += 1
    setCandidates(NO_CANDIDATES)
    staffGeneration.current += 1
    staffRef.current = null
    setStaff(null); setStaffError(null); setStaffLoading(false); setPickerBlock(null)
    setReplaceTarget(null) // REPLACE.1a — a studio switch closes this picker too
  }, [locationId])

  // Refetch only when the pool was already loaded — a manager who never opened
  // the picker should not pay for a staff call on every assign/remove.
  const refreshStaffIfLoaded = useCallback(() => {
    if (staff !== null) loadStaff()
  }, [staff, loadStaff])

  async function loadCandidates(block) {
    const requestId = ++candidatesSeq.current
    setCandidates(candidatesStarted(block.id, requestId))
    let res
    try {
      res = await getBlockCandidates(block.id, { locationId })
    } catch (e) {
      res = { success: false, error: e?.message }
    }
    // A studio the manager has since left: its answer is not for this screen.
    if (locationId !== currentLocation.current) return
    setCandidates((prev) => candidatesSettled(prev, { blockId: block.id, requestId, res }))
  }

  async function openPicker(block) {
    setPickerBlock(block)
    loadCandidates(block) // not awaited: the staff list below is the fallback
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
    // REPLACE.1a — which actions, and in what order: coachPressActions.
    const buttons = {
      adjust: { text: 'Adjust times', onPress: () => onAdjust(adjustTargetFor(block, assignment)) },
      replace: { text: 'Replace coach', onPress: () => openReplace(block, assignment) },
      remove: { text: 'Remove from shift', style: 'destructive', onPress: () => confirmRemove(block, assignment) },
    }
    Alert.alert(
      assignment.profiles?.full_name || 'Coach',
      `${block.shift_templates?.name || 'Shift'} · ${block.block_date}`,
      [...coachPressActions(block, dublinTodayIso()).map((k) => buttons[k]), { text: 'Cancel', style: 'cancel' }],
    )
  }

  // REPLACE.1a — the Add-coach picker, titled for the coach going off, on
  // CANDIDATES.1's ranked list for this block (which leaves out everyone live
  // on it, the outgoing coach included; the A-Z staff list is the fallback,
  // as for Add coach). The two sheets share the candidates state: only one is
  // ever open, and candidatesFor hands a sheet only its own block's answer.
  // The pick IS the confirmation (as for Add coach); an Alert is shown only
  // after the network answer.
  async function openReplace(block, assignment) {
    setReplaceTarget({ block, assignment })
    loadCandidates(block) // not awaited: the staff list below is the fallback
    if (staff === null && !staffLoading) await loadStaff()
  }

  async function runReplace(target, coach, confirmConflicts = false) {
    setBusyId(target.block.id)
    const res = await replaceAssignment(target.assignment.id, { profileId: coach.id, confirmConflicts, locationId })
    setBusyId(null)
    const out = replaceResultAlert(res, { fromName: target.assignment.profiles?.full_name, toName: coach.full_name })
    if (out.kind === 'confirm') {
      Alert.alert(out.title, out.message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace anyway', onPress: () => runReplace(target, coach, true) },
      ])
      return
    }
    Alert.alert(out.title, out.message)
    if (out.kind === 'done') { load(); refreshStaffIfLoaded() }
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
          {stale ? <Text className="text-un1t-subtle text-xs mt-1">Showing the last roster that loaded.</Text> : null}
          {canRetry ? (
            <Pressable onPress={retry} hitSlop={8} className="mt-2 self-start active:opacity-60">
              <Text className="text-sm font-semibold text-un1t-text">Retry</Text>
            </Pressable>
          ) : null}
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
        staff={staff} loading={staffLoading} error={staff === null ? staffError : null} onRetry={loadStaff}
        {...candidatesFor(candidates, pickerBlock?.id)}
        onPick={pickCoach} onClose={() => setPickerBlock(null)} />

      {/* REPLACE.1a — the same sheet, one pick, titled for the coach going off. */}
      <CoachPickerSheet visible={!!replaceTarget} block={replaceTarget?.block ?? null} locationId={locationId}
        staff={staff} loading={staffLoading} error={staff === null ? staffError : null} onRetry={loadStaff}
        {...candidatesFor(candidates, replaceTarget?.block?.id)}
        title={replaceTarget ? replacePickerTitle(replaceTarget.assignment) : ''}
        emptyText="No other coaches at this studio."
        onPick={(coach) => { const t = replaceTarget; setReplaceTarget(null); if (t) runReplace(t, coach) }}
        onClose={() => setReplaceTarget(null)} />
    </View>
  )
}

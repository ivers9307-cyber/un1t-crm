# Mobile Schedule Editing (Manager "Manage" Mode) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manager-only **Manage** mode to the mobile Schedule tab where `MANAGER_ROLES` can assign/remove/adjust coaches on the selected day's shift blocks and approve/reject pending time-off & swap requests.

**Architecture:** Mobile-only. No backend, migration, or permission change — every read + mutation route already exists, is `MANAGER_ROLES`-gated, and returns coach names via service-role. A pure helper module (`schedule-manage.js`) owns fill-state + coach-filter logic (unit-tested); six thin helpers in `schedule-api.js` wrap the existing routes; four new components under `mobile/components/schedule/` render the UI; `schedule.jsx` gains a `manage` view + a manager-only segment and reuses its existing `AdjustSheet`.

**Tech Stack:** Expo / React Native, expo-router, NativeWind, Vitest (`mobile/lib/**`).

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-schedule-editing-design.md` · **Branch:** `mobile-schedule-editing` (checked out, spec committed).

---

## Verified API contracts (read 2026-06-04 — use these shapes verbatim)

```
GET /api/schedule/blocks?location_id&start_date&end_date   (MANAGER_ROLES + assertLocationAccess)
  → { success, data: [ {
        id, location_id, template_id, block_date, start_time, end_time,
        max_coaches, min_coaches, notes, roster_id,
        shift_templates: { id, name, color, role_label, start_time, end_time, days_of_week, max_coaches },
        shift_assignments: [ { id, profile_id, notes, status, assigned_at,
            start_time_override, end_time_override, partial_reason,
            profiles: { id, full_name, email, avatar_url, role } } ]   // [] for empty blocks
      } ] }

POST /api/schedule/blocks/:id/assignments   (MANAGER_ROLES)   body { profile_id, allow_over_capacity? }
  → 201 { success:true, data:<assignment>, warnings?:[string] }
  → 409 { success:false, error:"This coach is already assigned to this block." }
  → 409 { success:false, error:"Block is at capacity (N/max). Pass allow_over_capacity: true to override." }

DELETE /api/schedule/assignments/:id   (self or MANAGER_ROLES)   → { success }

PUT /api/schedule/assignments/:id  body { start_time_override?, end_time_override?, partial_reason? }
  → already wrapped by adjustShiftAssignment()

GET /api/schedule/time-off?status=pending&location_id   (manager sees location-wide; staff own-only)
  → { success, data: [ { id, profile_id, type, start_date, end_date, total_days, reason, status,
        profiles: { id, full_name, avatar_url, role } } ] }
PUT /api/schedule/time-off/:id   body { status:'approved'|'rejected', review_note? }   (MANAGER_ROLES)

GET /api/schedule/swaps?status=pending&location_id   → already wrapped by getOpenSwaps()
  → data: [ { id, requester:{full_name}, requester_shift:{ shift_date, shift_templates:{name}, ... }, reason } ]
PUT /api/schedule/swaps/:id  → already wrapped by respondToSwap(id, status, reviewNote, locationId)

GET /api/staff   (scoped to caller's locations)
  → { success, data: [ { id, full_name, email, role, avatar_url, active,
        profile_locations: [ { location_id, role, locations:{id,name,slug} } ] } ] }
```

`mobile/lib/api.js` forwards `options.method` to `fetch`, so `DELETE` works.

---

## File Structure

| File | Responsibility |
|---|---|
| `mobile/lib/schedule-manage.js` + `.test.js` | **new** — pure `blockFillState`, `filterAssignableCoaches` |
| `mobile/lib/schedule-api.js` | **+6 helpers** wrapping the routes above |
| `mobile/components/schedule/ApprovalCard.jsx` | **new** — one pending time-off/swap row + Approve/Reject |
| `mobile/components/schedule/BlockCard.jsx` | **new** — one block: header + capacity chip + coach rows + Add coach |
| `mobile/components/schedule/CoachPickerSheet.jsx` | **new** — modal list of assignable coaches |
| `mobile/components/schedule/ManageMode.jsx` | **new** — orchestrator: fetch + approvals section + day's blocks + handlers |
| `mobile/app/(tabs)/schedule.jsx` | **modify** — `manage` view, manager-only segment, impersonation guard, render `ManageMode`, refresh-on-adjust |

---

## Task 1: Pure `schedule-manage.js` (TDD)

**Files:** Create `mobile/lib/schedule-manage.js`; Test `mobile/lib/schedule-manage.test.js`

- [ ] **Step 1: Write the failing tests**

`mobile/lib/schedule-manage.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { blockFillState, filterAssignableCoaches } from './schedule-manage'

const block = (assignedCount, min, max) => ({
  min_coaches: min, max_coaches: max,
  shift_assignments: Array.from({ length: assignedCount }, (_, i) => ({ profile_id: `p${i}` })),
})

describe('blockFillState', () => {
  it('under when assigned < min_coaches', () => {
    expect(blockFillState(block(1, 2, 3))).toBe('under')
  })
  it('ok when within min..max', () => {
    expect(blockFillState(block(2, 2, 3))).toBe('ok')
    expect(blockFillState(block(3, 2, 3))).toBe('ok')
  })
  it('over when assigned > max_coaches', () => {
    expect(blockFillState(block(4, 2, 3))).toBe('over')
  })
  it('treats missing min as 0 and missing max as unbounded', () => {
    expect(blockFillState({ shift_assignments: [] })).toBe('ok')
    expect(blockFillState(block(9, null, null))).toBe('ok')
    expect(blockFillState(block(0, 1, 3))).toBe('under')
  })
})

describe('filterAssignableCoaches', () => {
  const staff = [
    { id: 'a', full_name: 'Zoe', active: true, profile_locations: [{ location_id: 'loc1' }] },
    { id: 'b', full_name: 'Amy', active: true, profile_locations: [{ location_id: 'loc1' }] },
    { id: 'c', full_name: 'Inactive', active: false, profile_locations: [{ location_id: 'loc1' }] },
    { id: 'd', full_name: 'OtherLoc', active: true, profile_locations: [{ location_id: 'loc2' }] },
  ]
  const blk = { shift_assignments: [{ profile_id: 'b' }] } // Amy already on

  it('keeps active, in-location, not-already-assigned coaches, sorted by name', () => {
    const out = filterAssignableCoaches(staff, blk, 'loc1')
    expect(out.map(c => c.id)).toEqual(['a']) // Amy assigned, Inactive inactive, OtherLoc elsewhere
  })
  it('sorts remaining by full_name', () => {
    const out = filterAssignableCoaches(staff, { shift_assignments: [] }, 'loc1')
    expect(out.map(c => c.full_name)).toEqual(['Amy', 'Zoe'])
  })
  it('tolerates non-arrays', () => {
    expect(filterAssignableCoaches(null, blk, 'loc1')).toEqual([])
    expect(filterAssignableCoaches(staff, null, 'loc1').map(c => c.id).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/schedule-manage.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`mobile/lib/schedule-manage.js`:

```js
// Pure helpers for the Schedule tab's manager "Manage" mode. No React/Supabase
// — pure functions over the /api/schedule/blocks shape (a shift_block with
// shift_assignments[] each embedding profiles) and the /api/staff shape.
// Lives in mobile/lib so the root vitest picks it up (config includes mobile/lib/**).

// Fill state of a block vs capacity. 'under' = fewer than min_coaches assigned;
// 'over' = more than max_coaches; else 'ok'. Missing min → 0, missing max → ∞.
export function blockFillState(block) {
  const n = Array.isArray(block?.shift_assignments) ? block.shift_assignments.length : 0
  const min = block?.min_coaches ?? 0
  const max = block?.max_coaches
  if (n < min) return 'under'
  if (max != null && n > max) return 'over'
  return 'ok'
}

// Coaches assignable to a block: active staff who belong to `locationId` and
// aren't already on the block, sorted by name. `staff` is the /api/staff data
// array (each { id, full_name, active, profile_locations:[{ location_id }] }).
export function filterAssignableCoaches(staff, block, locationId) {
  const assigned = new Set((block?.shift_assignments || []).map((a) => a.profile_id))
  return (Array.isArray(staff) ? staff : [])
    .filter((s) => {
      if (!s || s.active === false) return false
      if (assigned.has(s.id)) return false
      return (s.profile_locations || []).some((pl) => pl.location_id === locationId)
    })
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mobile/lib/schedule-manage.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/schedule-manage.js mobile/lib/schedule-manage.test.js
git commit -m "MOBILE-SCHED-EDIT.1 — pure schedule-manage helpers (blockFillState, filterAssignableCoaches) + tests"
```

---

## Task 2: Six API helpers in `schedule-api.js`

**Files:** Modify `mobile/lib/schedule-api.js`

No unit test (thin `api()` wrappers, like the existing `getMyShifts`; validated by `expo export` + on-device).

- [ ] **Step 1: Append the helpers** at the end of `mobile/lib/schedule-api.js`:

```js
// --- Manager "Manage" mode (MOBILE-SCHED-EDIT) ---------------------------

// All shift blocks for the location/week, incl. empty ones, with capacity +
// assigned coaches (names via the service-role route). MANAGER_ROLES-gated.
export function getScheduleBlocks({ locationId, startDate, endDate }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  if (startDate) qs.set('start_date', startDate)
  if (endDate) qs.set('end_date', endDate)
  return api(`/api/schedule/blocks?${qs.toString()}`, { locationId })
}

// Assign one coach to a block. On 409 "at capacity", the caller re-invokes
// with allowOverCapacity:true. Response may carry warnings[] (advisories).
export function assignCoachToBlock(blockId, { profileId, allowOverCapacity, locationId }) {
  return api(`/api/schedule/blocks/${blockId}/assignments`, {
    method: 'POST',
    locationId,
    body: { profile_id: profileId, allow_over_capacity: allowOverCapacity || undefined },
  })
}

// Remove a coach from a shift (delete the assignment).
export function removeAssignment(assignmentId, { locationId }) {
  return api(`/api/schedule/assignments/${assignmentId}`, { method: 'DELETE', locationId })
}

// Location-wide pending time-off (managers). Staff get own-only server-side.
export function getPendingTimeOff({ locationId }) {
  const qs = new URLSearchParams()
  if (locationId) qs.set('location_id', locationId)
  qs.set('status', 'pending')
  return api(`/api/schedule/time-off?${qs.toString()}`, { locationId })
}

// Approve / reject a time-off request (MANAGER_ROLES).
export function respondToTimeOff(id, status, reviewNote, locationId) {
  return api(`/api/schedule/time-off/${id}`, {
    method: 'PUT',
    locationId,
    body: { status, review_note: reviewNote || null },
  })
}

// Assignable staff at the active location (id + full_name + active + locations).
export function getLocationStaff({ locationId }) {
  return api('/api/staff', { locationId })
}
```

- [ ] **Step 2: Verify it parses**

Run: `cd mobile && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error. (Deferred to Task 6 if you prefer one export at the end — but a quick check here catches typos early.)

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/schedule-api.js
git commit -m "MOBILE-SCHED-EDIT.2 — schedule-api helpers (blocks, assign, remove, pending time-off, respond, staff)"
```

---

## Task 3: `ApprovalCard` component

**Files:** Create `mobile/components/schedule/ApprovalCard.jsx`

- [ ] **Step 1: Create the file**

```jsx
// One pending approval row (time-off OR swap) with Approve / Reject.
// Read-only data; the parent (ManageMode) owns the mutation + refetch.
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function ApprovalCard({ kind, item, busy, onApprove, onReject }) {
  let who, summary
  if (kind === 'timeoff') {
    who = item.profiles?.full_name || 'Someone'
    const label = item.type === 'holiday' ? 'Holiday' : item.type === 'sick' ? 'Sick' : 'Time off'
    const range = item.end_date && item.end_date !== item.start_date
      ? `${item.start_date} → ${item.end_date}` : item.start_date
    summary = `${label} · ${range}`
  } else {
    who = item.requester?.full_name || 'Someone'
    const sh = item.requester_shift
    summary = `Swap · ${sh?.shift_templates?.name || 'shift'}${sh?.shift_date ? ` · ${sh.shift_date}` : ''}`
  }
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-3.5 mb-2">
      <Text className="text-sm font-semibold text-un1t-text" numberOfLines={1}>{who}</Text>
      <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={1}>{summary}</Text>
      {item.reason ? (
        <Text className="text-[12px] text-un1t-subtle mt-1 italic" numberOfLines={2}>“{item.reason}”</Text>
      ) : null}
      <View className="flex-row gap-2 mt-2.5">
        <Pressable onPress={onApprove} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
          {busy
            ? <ActivityIndicator color="#FFFFFF" />
            : <><Ionicons name="checkmark" size={15} color="#FFFFFF" /><Text className="text-sm font-semibold text-white ml-1">Approve</Text></>}
        </Pressable>
        <Pressable onPress={onReject} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl border border-un1t-border active:opacity-60 disabled:opacity-50">
          <Ionicons name="close" size={15} color="#DC2626" />
          <Text className="text-sm font-semibold text-red-600 ml-1">Reject</Text>
        </Pressable>
      </View>
    </View>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add mobile/components/schedule/ApprovalCard.jsx
git commit -m "MOBILE-SCHED-EDIT.3 — ApprovalCard (pending time-off/swap approve-reject row)"
```

---

## Task 4: `BlockCard` + `CoachPickerSheet`

**Files:** Create `mobile/components/schedule/BlockCard.jsx`, `mobile/components/schedule/CoachPickerSheet.jsx`

- [ ] **Step 1: Create `BlockCard.jsx`**

```jsx
// One shift block in Manage mode: header (name + capacity chip), the assigned
// coaches (tap a coach → parent opens an action sheet), and "+ Add coach".
import { View, Text, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { timeRange } from '../../lib/dates'
import { effShiftStart, effShiftEnd, initials } from '../../lib/schedule-team'
import { blockFillState } from '../../lib/schedule-manage'

const CHIP_BG = { under: 'bg-amber-500/20', over: 'bg-red-500/20', ok: 'bg-un1t-border' }
const CHIP_TX = { under: 'text-amber-700', over: 'text-red-700', ok: 'text-un1t-subtle' }

export default function BlockCard({ block, busy, onAddCoach, onCoachPress }) {
  const tpl = block.shift_templates
  const coaches = block.shift_assignments || []
  const state = blockFillState(block)
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 mb-2">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-base font-semibold text-un1t-text flex-1 mr-2" numberOfLines={1}>{tpl?.name || 'Shift'}</Text>
        <View className={`px-2 py-0.5 rounded-full ${CHIP_BG[state]}`}>
          <Text className={`text-[10px] font-bold ${CHIP_TX[state]}`}>{coaches.length}/{block.max_coaches ?? '—'}</Text>
        </View>
      </View>
      <View className="flex-row items-center mb-2">
        <Ionicons name="time-outline" size={13} color="#64748B" />
        <Text className="text-sm text-un1t-subtle ml-1">
          {timeRange(block.start_time || tpl?.start_time, block.end_time || tpl?.end_time)}
        </Text>
      </View>

      {coaches.length === 0 ? (
        <Text className="text-[12px] text-un1t-muted italic mb-1">No one assigned yet.</Text>
      ) : coaches.map((a) => {
        const adj = !!(a.start_time_override || a.end_time_override)
        return (
          <Pressable key={a.id} onPress={() => onCoachPress(a)} disabled={busy}
            className="flex-row items-center py-1.5 active:opacity-60">
            <View className="w-7 h-7 rounded-full bg-un1t-border items-center justify-center mr-2">
              <Text className="text-[11px] font-semibold text-un1t-text">{initials(a.profiles?.full_name)}</Text>
            </View>
            <Text className="text-sm text-un1t-text flex-1" numberOfLines={1}>{a.profiles?.full_name || 'Unknown'}</Text>
            {adj ? <Text className="text-[11px] text-amber-700 mr-1">{timeRange(effShiftStart(a), effShiftEnd(a))}</Text> : null}
            <Ionicons name="ellipsis-horizontal" size={16} color="#94A3B8" />
          </Pressable>
        )
      })}

      <Pressable onPress={onAddCoach} disabled={busy}
        className="flex-row items-center justify-center mt-2 py-2 rounded-xl border border-dashed border-un1t-border active:opacity-60">
        <Ionicons name="add" size={16} color="#111827" />
        <Text className="text-sm font-medium text-un1t-text ml-1">Add coach</Text>
      </Pressable>
    </View>
  )
}
```

- [ ] **Step 2: Create `CoachPickerSheet.jsx`**

```jsx
// Bottom-sheet picker of coaches assignable to a block. Pure-presentational:
// receives the already-fetched staff array; filters with the shared helper.
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { initials } from '../../lib/schedule-team'
import { filterAssignableCoaches } from '../../lib/schedule-manage'

export default function CoachPickerSheet({ visible, block, locationId, staff, loading, onPick, onClose }) {
  const coaches = block ? filterAssignableCoaches(staff || [], block, locationId) : []
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5" style={{ maxHeight: '70%' }}>
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">Add coach{block?.shift_templates?.name ? ` · ${block.shift_templates.name}` : ''}</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          {loading && staff === null ? (
            <View className="py-8 items-center"><ActivityIndicator /></View>
          ) : coaches.length === 0 ? (
            <Text className="text-sm text-un1t-subtle py-6 text-center">No available coaches to add.</Text>
          ) : (
            <ScrollView>
              {coaches.map((c) => (
                <Pressable key={c.id} onPress={() => onPick(c)}
                  className="flex-row items-center py-3 border-b border-un1t-border active:opacity-60">
                  <View className="w-9 h-9 rounded-full bg-un1t-border items-center justify-center mr-3">
                    <Text className="text-sm font-semibold text-un1t-text">{initials(c.full_name)}</Text>
                  </View>
                  <Text className="text-base text-un1t-text flex-1" numberOfLines={1}>{c.full_name}</Text>
                  {c.role ? <Text className="text-[11px] uppercase text-un1t-subtle">{String(c.role).replace(/_/g, ' ')}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add mobile/components/schedule/BlockCard.jsx mobile/components/schedule/CoachPickerSheet.jsx
git commit -m "MOBILE-SCHED-EDIT.4 — BlockCard + CoachPickerSheet (block editor primitives)"
```

---

## Task 5: `ManageMode` orchestrator

**Files:** Create `mobile/components/schedule/ManageMode.jsx`

- [ ] **Step 1: Create the file**

```jsx
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
```

- [ ] **Step 2: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error (all imports resolve — even though `ManageMode` isn't wired into a screen yet, expo compiles every file under `app/` and reachable imports; if it's not yet reachable, Task 6's export is the real gate. Either way, no syntax error.)

- [ ] **Step 3: Commit**

```bash
git add mobile/components/schedule/ManageMode.jsx
git commit -m "MOBILE-SCHED-EDIT.5 — ManageMode orchestrator (approvals + day block editor + mutations)"
```

---

## Task 6: Wire into `schedule.jsx`

**Files:** Modify `mobile/app/(tabs)/schedule.jsx`

- [ ] **Step 1: Import `ManageMode`** — after the `schedule-team` import line, add:

```jsx
import ManageMode from '../../components/schedule/ManageMode'
```

- [ ] **Step 2: Add the manage refresh key** — immediately after the `const [view, setView] = useState('me')` line, add:

```jsx
  const [manageRefreshKey, setManageRefreshKey] = useState(0)
```

- [ ] **Step 3: Skip the Me/Team fetch in manage mode** — in `fetchWeek`, change the opening guard from:

```jsx
  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    if (view === 'team') {
```

to:

```jsx
  const fetchWeek = useCallback(async () => {
    if (!profile || !activeLocation) return
    setError(null)
    if (view === 'manage') return // ManageMode self-fetches the roster + approvals
    if (view === 'team') {
```

- [ ] **Step 4: Add the impersonation / role guard** — immediately after the `useFocusEffect(useCallback(() => { fetchWeek() }, [fetchWeek]))` line, add:

```jsx
  // If the effective role loses manager rights while in Manage mode (e.g. a
  // master starts "View as user" on a staff member), drop back to Me so the
  // manager-only UI/calls never render for a non-manager identity.
  useEffect(() => {
    if (view === 'manage' && !isManagerRole(profile?.role)) setView('me')
  }, [profile?.role, view])
```

- [ ] **Step 5: Make the segmented control manager-aware** — replace the segmented-control block:

```jsx
        {/* Me / Team segmented control */}
        <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-4">
          {[['me', 'Me'], ['team', 'Team']].map(([val, label]) => {
            const active = view === val
            return (
              <Pressable
                key={val}
                onPress={() => setView(val)}
                className={`flex-1 items-center py-2 rounded-lg ${active ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-sm font-semibold ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {label}
                </Text>
              </Pressable>
            )
          })}
        </View>
```

with (adds the `Manage` segment only for managers):

```jsx
        {/* Me / Team [/ Manage] segmented control */}
        <View className="flex-row bg-un1t-surface border border-un1t-border rounded-xl p-1 mb-4">
          {(isManagerRole(profile?.role)
            ? [['me', 'Me'], ['team', 'Team'], ['manage', 'Manage']]
            : [['me', 'Me'], ['team', 'Team']]
          ).map(([val, label]) => {
            const active = view === val
            return (
              <Pressable
                key={val}
                onPress={() => setView(val)}
                className={`flex-1 items-center py-2 rounded-lg ${active ? 'bg-un1t-text' : ''}`}
              >
                <Text className={`text-sm font-semibold ${active ? 'text-un1t-bg' : 'text-un1t-subtle'}`}>
                  {label}
                </Text>
              </Pressable>
            )
          })}
        </View>
```

- [ ] **Step 6: Render `ManageMode`** — the content render currently begins:

```jsx
        {loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : isTablet ? (
```

Change it to put Manage first (it self-manages loading), so the screen's `loading` gate is bypassed in manage mode:

```jsx
        {view === 'manage' ? (
          <ManageMode
            activeLocation={activeLocation}
            weekStart={start}
            weekEnd={end}
            selectedIso={selectedIso}
            selectedLabel={selected.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            refreshKey={manageRefreshKey}
            onAdjust={setAdjustingShift}
          />
        ) : loading ? (
          <View className="py-12 items-center">
            <ActivityIndicator />
          </View>
        ) : isTablet ? (
```

(The rest of the ternary — `isTablet ? … : view === 'team' ? … : ( … )` — is unchanged.)

- [ ] **Step 7: Refresh ManageMode after an adjust** — the `AdjustSheet` at the bottom has `onSaved={() => { setAdjustingShift(null); fetchWeek() }}`. Change it to also bump the manage key:

```jsx
      <AdjustSheet
        shift={adjustingShift}
        onClose={() => setAdjustingShift(null)}
        onSaved={() => { setAdjustingShift(null); fetchWeek(); setManageRefreshKey((k) => k + 1) }}
        locationId={activeLocation?.id}
      />
```

- [ ] **Step 8: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -4 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error.

- [ ] **Step 9: Commit**

```bash
git add mobile/app/\(tabs\)/schedule.jsx
git commit -m "MOBILE-SCHED-EDIT.6 — manager-only Manage segment + render ManageMode (impersonation-guarded)"
```

---

## Task 7: Verify + ship

**Files:** none.

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity`
Expected: vitest green (incl. the new `schedule-manage.test.js`); eslint 0 errors (the pre-existing `ChooserEditorForm.jsx` warning is unrelated); parity exit 0 (no permission change).

- [ ] **Step 2: Final iOS export**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios && rm -rf dist && cd ..`
Expected: `Exported: dist`, no errors.

- [ ] **Step 3: Push**

```bash
git push -u origin mobile-schedule-editing
```

- [ ] **Step 4: Open the PR** (base `main`, head `mobile-schedule-editing`) — title `MOBILE-SCHED-EDIT — manager schedule editing on mobile`, body summarising: Manage mode for `MANAGER_ROLES` (assign/remove/adjust coaches on the day's blocks + approve/reject time-off & swaps); reuses existing routes (no backend/migration/permission); verification line. Note merging touches `mobile/**` → production OTA.

- [ ] **Step 5: STOP — ask the user before merging.** Merging auto-publishes a production OTA. Report the PR URL + the on-device test checklist:
  - Non-manager sees only `Me | Team` (no Manage segment).
  - Manager sees `Manage`; the day's blocks show capacity chips (amber under-min).
  - Add coach (picker excludes already-assigned/other-location/inactive); over-capacity confirm works.
  - Tap a coach → Adjust times (sheet) / Remove (confirm) → list refreshes.
  - Approve & reject a time-off and a swap → they leave the pending list.
  - Master "View as user" → staff: Manage segment disappears, view falls back to Me.

---

## Self-Review

**Spec coverage:** Manage segment (T6 s5) ✓ · approvals section time-off + swaps (T5 + T3) ✓ · approve/reject (`respondToTimeOff`/`respondToSwap`, T2/T5) ✓ · block-centric day editor (T5 + T4) ✓ · capacity chip under-min amber (`blockFillState`, T1 + T4) ✓ · assign with over-capacity confirm (T5 `pickCoach`) ✓ · advisories surfaced (warnings join, T5) ✓ · remove coach (T5 `confirmRemove`) ✓ · adjust via existing AdjustSheet (onAdjust + adapt object, T5/T6) ✓ · coach picker from /api/staff minus assigned (`filterAssignableCoaches`, T1+T4) ✓ · role-gate MANAGER_ROLES, no new permission (T6 s5, `isManagerRole`) ✓ · impersonation reset (T6 s4) ✓ · refetch-not-optimistic (T5 `load()` after each mutation) ✓ · empty states (T5) ✓ · pure helper unit-tested under mobile/lib (T1) ✓ · no backend/parity change ✓.

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** helpers `getScheduleBlocks/assignCoachToBlock/removeAssignment/getPendingTimeOff/respondToTimeOff/getLocationStaff` defined in T2 and imported in T5; `blockFillState/filterAssignableCoaches` defined T1, used T4; existing `getOpenSwaps/respondToSwap/adjustShiftAssignment/effShiftStart/effShiftEnd/initials/timeRange/isManagerRole` reused; `ManageMode` props (`activeLocation, weekStart, weekEnd, selectedIso, selectedLabel, refreshKey, onAdjust`) match the call site in T6 s6; `start`/`end` are the screen's existing week-ISO memos, `selectedIso`/`selected` exist; the adapted shift object for `AdjustSheet` carries `shift_assignment_id` + `shift_templates` + overrides, matching what `AdjustSheet` reads.

**Known cosmetic gap (intentional):** the `WeekStrip` count dots read from the Me/Team `shifts` state, which isn't populated in manage mode → no coverage dots while managing (day selection still works). Out of scope for v1; a future enhancement could feed block coverage into the dots.

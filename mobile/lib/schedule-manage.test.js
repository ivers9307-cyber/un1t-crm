import { describe, it, expect } from 'vitest'
import {
  blockFillState, liveBlockAssignments, adjustTargetFor, assignmentWindow,
  filterAssignableCoaches, canAdjustShiftTimes, canCancelTimeOff, scheduleViewFromParam,
} from './schedule-manage'
import { blockStart, blockEnd } from './schedule-team'

const TODAY = '2026-09-17'
const block = (assignedCount, min, max, over = {}) => ({
  block_date: '2026-09-18',
  min_coaches: min, max_coaches: max,
  shift_assignments: Array.from({ length: assignedCount }, (_, i) => ({ profile_id: `p${i}`, status: 'scheduled' })),
  ...over,
})
const cancelled = (id) => ({ profile_id: id, status: 'cancelled' })

// MOBILESCHED.2 — the chip answers from shared/roster-staffing (the web
// calendar's function) on LIVE assignments, and tells empty from short.
describe('blockFillState', () => {
  it('short when some live coaches but fewer than min_coaches, labelled "1 of 2"', () => {
    expect(blockFillState(block(1, 2, 3), TODAY)).toEqual({ state: 'short', count: 1, min: 2, max: 3, label: '1 of 2' })
  })
  it('empty when nobody is on it, whatever the minimum', () => {
    expect(blockFillState(block(0, 1, 3), TODAY)).toMatchObject({ state: 'empty', label: 'No coach' })
    expect(blockFillState(block(0, 0, 3), TODAY)).toMatchObject({ state: 'empty', label: 'No coach' })
    expect(blockFillState({ block_date: '2026-09-18', shift_assignments: [] }, TODAY).state).toBe('empty')
  })
  it('ok when within min..max, labelled count/max', () => {
    expect(blockFillState(block(2, 2, 3), TODAY)).toMatchObject({ state: 'ok', label: '2/3' })
    expect(blockFillState(block(3, 2, 3), TODAY).state).toBe('ok')
    expect(blockFillState(block(9, null, null), TODAY)).toMatchObject({ state: 'ok', label: '9/—' })
  })
  it('over when live coaches > max_coaches', () => {
    expect(blockFillState(block(4, 2, 3), TODAY)).toMatchObject({ state: 'over', label: '4/3' })
  })
  it('does NOT count a cancelled assignment as a coach', () => {
    const b = block(1, 2, 3)
    b.shift_assignments.push(cancelled('gone'))
    expect(blockFillState(b, TODAY)).toMatchObject({ state: 'short', count: 1, label: '1 of 2' })
    const onlyCancelled = block(0, 1, 3, { shift_assignments: [cancelled('a'), cancelled('b')] })
    expect(blockFillState(onlyCancelled, TODAY)).toMatchObject({ state: 'empty', count: 0 })
  })
  it('counts a legacy row with no status, and a swapped row, as live', () => {
    const b = block(0, 2, 3, { shift_assignments: [{ profile_id: 'a' }, { profile_id: 'b', status: 'swapped' }] })
    expect(blockFillState(b, TODAY)).toMatchObject({ state: 'ok', count: 2 })
  })
  it('a past block is history: never empty/short, still over capacity', () => {
    expect(blockFillState(block(0, 2, 3, { block_date: '2026-09-16' }), TODAY)).toMatchObject({ state: 'ok', label: '0/3' })
    expect(blockFillState(block(4, 2, 3, { block_date: '2026-09-16' }), TODAY).state).toBe('over')
  })
  it('today is not past', () => {
    expect(blockFillState(block(1, 2, 3, { block_date: TODAY }), TODAY).state).toBe('short')
  })
})

describe('liveBlockAssignments', () => {
  it('drops cancelled rows only and tolerates junk', () => {
    const b = { shift_assignments: [{ id: 1, status: 'scheduled' }, { id: 2, status: 'cancelled' }, { id: 3 }] }
    expect(liveBlockAssignments(b).map((a) => a.id)).toEqual([1, 3])
    expect(liveBlockAssignments(null)).toEqual([])
    expect(liveBlockAssignments({ shift_assignments: 'x' })).toEqual([])
  })
})

// MOBILESCHED.2 — Manage mode's Adjust sheet and coach rows resolve times
// against the BLOCK, falling back to the template.
describe('adjustTargetFor', () => {
  const tpl = { name: 'AM', start_time: '06:00:00', end_time: '14:00:00' }
  it('hands AdjustSheet the block times under the keys it reads', () => {
    const blk = { block_date: '2026-09-18', start_time: '07:00:00', end_time: '12:00:00', shift_templates: tpl }
    const a = { id: 'as-1', start_time_override: '08:00:00', end_time_override: null, partial_reason: 'late' }
    expect(adjustTargetFor(blk, a)).toEqual({
      shift_assignment_id: 'as-1',
      shift_date: '2026-09-18',
      block_start_time: '07:00:00',
      block_end_time: '12:00:00',
      shift_templates: tpl,
      start_time_override: '08:00:00',
      end_time_override: null,
      partial_reason: 'late',
    })
  })
  it('a block with no time of its own leaves the template as the fallback', () => {
    const t = adjustTargetFor({ block_date: '2026-09-18', shift_templates: tpl }, { id: 'x' })
    expect(t.block_start_time).toBeNull()
    expect(blockStart(t)).toBe('06:00:00')
    expect(blockEnd(t)).toBe('14:00:00')
  })
  it('the block default the sheet compares against is the block, not the template', () => {
    const t = adjustTargetFor({ block_date: '2026-09-18', start_time: '07:00:00', end_time: '12:00:00', shift_templates: tpl }, { id: 'x' })
    expect(blockStart(t)).toBe('07:00:00')
    expect(blockEnd(t)).toBe('12:00:00')
  })
})

describe('assignmentWindow', () => {
  const tpl = { start_time: '06:00:00', end_time: '14:00:00' }
  const blk = { start_time: '07:00:00', end_time: '12:00:00', shift_templates: tpl }
  it('override on top of the block time, per bound', () => {
    expect(assignmentWindow(blk, { start_time_override: '08:00:00' })).toEqual({ start: '08:00:00', end: '12:00:00' })
    expect(assignmentWindow(blk, { end_time_override: '11:00:00' })).toEqual({ start: '07:00:00', end: '11:00:00' })
  })
  it('falls back to the template when the block has no time', () => {
    expect(assignmentWindow({ shift_templates: tpl }, { start_time_override: '08:00:00' })).toEqual({ start: '08:00:00', end: '14:00:00' })
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

  it('keeps active, in-location, not-already-assigned coaches', () => {
    const out = filterAssignableCoaches(staff, blk, 'loc1')
    expect(out.map(c => c.id)).toEqual(['a']) // Amy assigned, Inactive inactive, OtherLoc elsewhere
  })
  it('sorts remaining by full_name', () => {
    const out = filterAssignableCoaches(staff, { shift_assignments: [] }, 'loc1')
    expect(out.map(c => c.full_name)).toEqual(['Amy', 'Zoe'])
  })
  it('offers a coach whose only assignment on the block is CANCELLED (the route re-adds them)', () => {
    const withTombstone = { shift_assignments: [{ profile_id: 'b', status: 'cancelled' }] }
    expect(filterAssignableCoaches(staff, withTombstone, 'loc1').map(c => c.id)).toEqual(['b', 'a'])
  })
  it('tolerates non-arrays', () => {
    expect(filterAssignableCoaches(null, blk, 'loc1')).toEqual([])
    expect(filterAssignableCoaches(staff, null, 'loc1').map(c => c.id).sort()).toEqual(['a', 'b'])
  })
})

// ROSTER-FIX.3 (D3) — Richard's call (2026-09-09): a coach is paid for a
// window a manager set, and only a manager changes it. The Schedule tab used
// to let a coach adjust their own shift ("if it's mine, I can move it"); the
// route now 403s that, so the affordance has to agree with the route.
describe('canAdjustShiftTimes', () => {
  const shift = { shift_assignment_id: 'assign-1', profile_id: 'coach-1' }

  it('is false for a coach looking at their OWN shift', () => {
    expect(canAdjustShiftTimes({ id: 'coach-1', role: 'staff' }, shift)).toBe(false)
  })
  it('is false for reception', () => {
    expect(canAdjustShiftTimes({ id: 'r1', role: 'reception' }, shift)).toBe(false)
  })
  it('is true for every manager role', () => {
    for (const role of ['master', 'owner', 'manager', 'head_coach']) {
      expect(canAdjustShiftTimes({ id: 'm1', role }, shift)).toBe(true)
    }
  })
  it('is true for a manager looking at their own shift too', () => {
    expect(canAdjustShiftTimes({ id: 'm1', role: 'manager' }, { ...shift, profile_id: 'm1' })).toBe(true)
  })
  it('is false without an assignment id, and tolerates a missing profile', () => {
    expect(canAdjustShiftTimes({ id: 'm1', role: 'manager' }, { profile_id: 'm1' })).toBe(false)
    expect(canAdjustShiftTimes(null, shift)).toBe(false)
    expect(canAdjustShiftTimes({ role: 'manager' }, null)).toBe(false)
  })
})

// ROSTER-FIX.7 — the coach-side "Cancel request" affordance on their own
// pending leave. Mirrors the self branch of PUT /api/schedule/time-off/[id],
// which accepts a self-cancel only from `pending`.
describe('canCancelTimeOff', () => {
  const me = { id: 'p1', role: 'staff' }
  const mine = { id: 't1', profile_id: 'p1', status: 'pending' }

  it('allows a coach to cancel their OWN pending request', () => {
    expect(canCancelTimeOff(mine, me)).toBe(true)
  })

  it('refuses once the request has been decided', () => {
    for (const status of ['approved', 'rejected', 'cancelled']) {
      expect(canCancelTimeOff({ ...mine, status }, me)).toBe(false)
    }
  })

  it('refuses someone else’s request, manager role or not', () => {
    expect(canCancelTimeOff({ ...mine, profile_id: 'p2' }, me)).toBe(false)
    expect(canCancelTimeOff({ ...mine, profile_id: 'p2' }, { id: 'p1', role: 'manager' })).toBe(false)
  })

  it('refuses when either side is missing rather than guessing', () => {
    expect(canCancelTimeOff(null, me)).toBe(false)
    expect(canCancelTimeOff(mine, null)).toBe(false)
    expect(canCancelTimeOff({ id: 't1', status: 'pending' }, me)).toBe(false)
    expect(canCancelTimeOff(mine, { role: 'staff' })).toBe(false)
  })
})

// RUNWAY.1 — ?view=manage on the schedule tab.
describe('scheduleViewFromParam', () => {
  it('opens Manage mode for every manager role', () => {
    for (const role of ['master', 'owner', 'manager', 'head_coach']) {
      expect(scheduleViewFromParam('manage', role)).toBe('manage')
    }
  })
  it('never for a coach, whatever the link says', () => {
    expect(scheduleViewFromParam('manage', 'staff')).toBeNull()
    expect(scheduleViewFromParam('manage', 'reception')).toBeNull()
    expect(scheduleViewFromParam('manage', undefined)).toBeNull()
  })
  it('ignores every other value, so an absent or junk param leaves the view alone', () => {
    for (const v of ['', 'me', 'team', 'MANAGE', undefined, null, ['manage']]) {
      expect(scheduleViewFromParam(v, 'owner')).toBeNull()
    }
  })
})

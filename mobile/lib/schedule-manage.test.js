import { describe, it, expect } from 'vitest'
import { blockFillState, filterAssignableCoaches, canAdjustShiftTimes, canCancelTimeOff } from './schedule-manage'

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

  it('keeps active, in-location, not-already-assigned coaches', () => {
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

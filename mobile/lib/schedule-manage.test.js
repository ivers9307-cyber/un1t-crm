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

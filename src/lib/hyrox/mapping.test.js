import { describe, it, expect } from 'vitest'
import { dublinDateStr, dublinWeekday, weekNoFor, slotFor } from './mapping'

describe('hyrox mapping (Dublin-safe)', () => {
  // 2026-07-22 is a Wednesday. 21:30 UTC is still Wed in Dublin (BST +1).
  it('reads the Dublin weekday for an evening instant', () => {
    expect(dublinDateStr('2026-07-22T21:30:00Z')).toBe('2026-07-22')
    expect(dublinWeekday('2026-07-22T21:30:00Z')).toBe(3) // Wed
  })
  // 2026-07-26 is a Sunday.
  it('maps weekday to slot via session_weekdays', () => {
    expect(slotFor([3, 7], '2026-07-22T18:00:00Z')).toBe(1) // Wed -> slot 1
    expect(slotFor([3, 7], '2026-07-26T10:00:00Z')).toBe(2) // Sun -> slot 2
    expect(slotFor([3, 7], '2026-07-24T18:00:00Z')).toBe(null) // Fri -> not a session day
  })
  it('computes week_no from the block start Monday', () => {
    // Block starts Mon 2026-07-20. Wed of week 1:
    expect(weekNoFor('2026-07-20', '2026-07-22T18:00:00Z', 12)).toBe(1)
    // Sun 2026-08-02 is 13 days after the Mon 2026-07-20 start: floor(13/7)+1 = week 2.
    expect(weekNoFor('2026-07-20', '2026-08-02T10:00:00Z', 12)).toBe(2)
    expect(weekNoFor('2026-07-20', '2026-07-19T10:00:00Z', 12)).toBe(null) // before start
    expect(weekNoFor('2026-07-20', '2026-11-01T10:00:00Z', 12)).toBe(null) // past week 12
  })
})

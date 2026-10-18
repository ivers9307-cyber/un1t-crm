// UN1TRADAR.2 — the phone labels an estimated arrears figure; a Glofox
// studio's text is unchanged.
import { describe, it, expect } from 'vitest'
import { ESTIMATE_NOTE, overdueValueNote, arrearsSublabel } from './arrears-estimate-label'

describe('arrears estimate labels', () => {
  it("arrearsSublabel matches today's copy when not estimated", () => {
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 1 })).toBe('1 member')
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 3 })).toBe('3 members')
    expect(arrearsSublabel(null)).toBe('arrears unavailable')
  })
  it('arrearsSublabel adds the estimate note', () => {
    expect(arrearsSublabel({ totalCents: 9000, memberCount: 2, estimated: true })).toBe('2 members, includes an estimate')
  })
  it('overdueValueNote only when flagged', () => {
    expect(overdueValueNote({})).toBeNull()
    expect(overdueValueNote(null)).toBeNull()
    expect(overdueValueNote({ overdueValueEstimated: true })).toBe('includes an estimate')
    expect(ESTIMATE_NOTE).toBe('includes an estimate')
  })
})

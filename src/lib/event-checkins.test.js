// Tests for the event check-in (attendance) helpers. Pure, Node env.

import { describe, it, expect } from 'vitest'
import { checkinCounts, registrationAttendance } from './event-checkins.js'

// A confirmed registration whose team has `members` people, of whom the
// first `present` are checked in.
const reg = (members, present = 0, status = 'confirmed') => ({
  status,
  team: {
    team_members: Array.from({ length: members }, (_, i) => ({
      id: `m${i}`,
      checked_in: i < present,
    })),
  },
})

describe('checkinCounts', () => {
  it('returns zeroes for null / empty input', () => {
    expect(checkinCounts(null)).toEqual({ present: 0, expected: 0 })
    expect(checkinCounts([])).toEqual({ present: 0, expected: 0 })
  })

  it('counts checked-in people vs total people across confirmed regs', () => {
    // team of 4 with 2 in, a solo who is in, a team of 3 with 0 in
    expect(checkinCounts([reg(4, 2), reg(1, 1), reg(3, 0)]))
      .toEqual({ present: 3, expected: 8 })
  })

  it('ignores non-confirmed registrations', () => {
    expect(checkinCounts([reg(2, 2), reg(5, 5, 'cancelled'), reg(3, 1, 'no_show')]))
      .toEqual({ present: 2, expected: 2 })
  })

  it('counts a confirmed registration with no member rows as 1 expected', () => {
    expect(checkinCounts([reg(0, 0)])).toEqual({ present: 0, expected: 1 })
  })
})

describe('registrationAttendance', () => {
  it('summarises a single registration', () => {
    expect(registrationAttendance(reg(4, 2)))
      .toEqual({ present: 2, expected: 4, allPresent: false, nonePresent: false })
  })

  it('flags allPresent when everyone is in', () => {
    expect(registrationAttendance(reg(3, 3)))
      .toEqual({ present: 3, expected: 3, allPresent: true, nonePresent: false })
  })

  it('flags nonePresent when nobody is in', () => {
    expect(registrationAttendance(reg(2, 0)))
      .toEqual({ present: 0, expected: 2, allPresent: false, nonePresent: true })
  })

  it('treats a memberless registration as one expected, none present', () => {
    expect(registrationAttendance(reg(0, 0)))
      .toEqual({ present: 0, expected: 1, allPresent: false, nonePresent: true })
  })
})

// Tests for the event check-in (attendance) helpers. Pure, Node env.

import { describe, it, expect } from 'vitest'
import { checkinCounts, registrationAttendance, buildCheckinView, defaultOpenGroup } from './event-checkins.js'

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

describe('buildCheckinView (CHECKINLAYOUT.1)', () => {
  const reg = (id, wave, order, time, people) => ({
    id, wave_id: wave, wave_label: wave ? `Wave ${wave}` : null, wave_time: time, _order: order,
    team: { name: `Team ${id}`, team_members: people.map(([name, inn, email], i) => ({ id: `${id}-${i}`, name, email: email || null, checked_in: !!inn })) },
  })

  it('one time: a single ungrouped list sorted by first name, counting everyone', () => {
    const v = buildCheckinView([reg('r1', 'w', 0, '12:30', [['Zoe A', false]]), reg('r2', 'w', 0, '12:30', [['Amy B', true], ['Bo B', false]])], { tab: 'all' })
    expect(v.grouped).toBe(false)
    expect(v.groups).toHaveLength(1)
    expect(v.groups[0].entries.map((e) => e.reg.id)).toEqual(['r2', 'r1'])
    expect(v).toMatchObject({ present: 1, expected: 3, toArrive: 2 })
  })

  it('several times: grouped by time in wave order, each with its own count', () => {
    const v = buildCheckinView([
      reg('r1', 'w2', 1, '09:20', [['Cy', false]]),
      reg('r2', 'w1', 0, '09:00', [['Ann', true]]),
      reg('r3', 'w2', 1, '09:20', [['Ben', true], ['Bea', false]]),
    ], { tab: 'all' })
    expect(v.grouped).toBe(true)
    expect(v.groups.map((g) => [g.key, g.time, g.present, g.expected])).toEqual([['w1', '09:00', 1, 1], ['w2', '09:20', 1, 3]])
    expect(v.groups[1].entries.map((e) => e.reg.id)).toEqual(['r3', 'r1'])
    expect(defaultOpenGroup(v.groups)).toBe('w2')
  })

  it('tabs filter people, not counts', () => {
    const regs = [reg('r1', 'w', 0, null, [['Ann', true], ['Bo', false]])]
    expect(buildCheckinView(regs, { tab: 'arrive' }).groups[0].entries[0].members.map((m) => m.name)).toEqual(['Bo'])
    expect(buildCheckinView(regs, { tab: 'in' }).groups[0].entries[0].members.map((m) => m.name)).toEqual(['Ann'])
    expect(buildCheckinView(regs, { tab: 'arrive' }).groups[0]).toMatchObject({ present: 1, expected: 2 })
  })

  it('search matches name, email (flagged) or team name', () => {
    const regs = [reg('r1', 'w', 0, null, [['Ann', false, 'ann@example.test']]), reg('r2', 'w', 0, null, [['Bo', false, 'zed@example.test']])]
    const byEmail = buildCheckinView(regs, { tab: 'all', query: 'zed@' })
    expect(byEmail.groups[0].entries).toHaveLength(1)
    expect(byEmail.groups[0].entries[0].members[0]).toMatchObject({ name: 'Bo', emailMatch: true })
    expect(buildCheckinView(regs, { tab: 'all', query: 'ann' }).groups[0].entries[0].members[0].emailMatch).toBe(true)
    expect(buildCheckinView(regs, { tab: 'all', query: 'team r2' }).groups[0].entries.map((e) => e.reg.id)).toEqual(['r2'])
  })

  it('opens the first time with anyone left to arrive, else the first', () => {
    expect(defaultOpenGroup([{ key: 'a', present: 2, expected: 2 }, { key: 'b', present: 0, expected: 3 }])).toBe('b')
    expect(defaultOpenGroup([{ key: 'a', present: 2, expected: 2 }])).toBe('a')
    expect(defaultOpenGroup([])).toBeNull()
  })
})

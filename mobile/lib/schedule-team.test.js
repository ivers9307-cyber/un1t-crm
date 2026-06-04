import { describe, it, expect } from 'vitest'
import { effShiftStart, effShiftEnd, initials, teamRosterForDay } from './schedule-team'

describe('initials', () => {
  it('first + last initial for multi-word names', () => {
    expect(initials('Mark Doyle')).toBe('MD')
    expect(initials('mary jane watson')).toBe('MW')
  })
  it('single letter for one-word names', () => {
    expect(initials('Cher')).toBe('C')
  })
  it('returns ? for empty / missing', () => {
    expect(initials('')).toBe('?')
    expect(initials(null)).toBe('?')
    expect(initials(undefined)).toBe('?')
  })
})

describe('effShiftStart / effShiftEnd', () => {
  it('prefers the override, falls back to the template default', () => {
    const base = { shift_templates: { start_time: '09:00:00', end_time: '13:00:00' } }
    expect(effShiftStart(base)).toBe('09:00:00')
    expect(effShiftEnd(base)).toBe('13:00:00')
    expect(effShiftStart({ ...base, start_time_override: '10:00:00' })).toBe('10:00:00')
    expect(effShiftEnd({ ...base, end_time_override: '12:30:00' })).toBe('12:30:00')
  })
  it('returns null when there is no time at all', () => {
    expect(effShiftStart({})).toBeNull()
    expect(effShiftEnd(null)).toBeNull()
  })
})

describe('teamRosterForDay', () => {
  const row = (id, day, name, start, profileId) => ({
    id,
    shift_date: day,
    profile_id: profileId,
    profiles: { id: profileId, full_name: name },
    shift_templates: { name: 'Floor', start_time: start, end_time: '13:00:00' },
  })

  it('filters to the given date', () => {
    const shifts = [
      row('a', '2026-06-04', 'Anna', '09:00:00', 'p1'),
      row('b', '2026-06-05', 'Ben', '09:00:00', 'p2'),
    ]
    expect(teamRosterForDay(shifts, '2026-06-04', 'pX').map(s => s.id)).toEqual(['a'])
  })

  it('sorts by effective start time then name', () => {
    const shifts = [
      row('late', '2026-06-04', 'Zoe', '13:00:00', 'p1'),
      row('earlyB', '2026-06-04', 'Bob', '09:00:00', 'p2'),
      row('earlyA', '2026-06-04', 'Amy', '09:00:00', 'p3'),
    ]
    expect(teamRosterForDay(shifts, '2026-06-04', 'pX').map(s => s.id))
      .toEqual(['earlyA', 'earlyB', 'late'])
  })

  it('respects a per-assignment override when sorting', () => {
    const base = row('ovr', '2026-06-04', 'Overrider', '08:00:00', 'p1')
    base.start_time_override = '14:00:00' // template says 08:00 but really starts 14:00
    const other = row('fixed', '2026-06-04', 'Fixed', '09:00:00', 'p2')
    expect(teamRosterForDay([base, other], '2026-06-04', 'pX').map(s => s.id))
      .toEqual(['fixed', 'ovr'])
  })

  it('marks the signed-in user’s own rows isSelf', () => {
    const shifts = [
      row('mine', '2026-06-04', 'Me', '09:00:00', 'me'),
      row('theirs', '2026-06-04', 'Them', '10:00:00', 'them'),
    ]
    const out = teamRosterForDay(shifts, '2026-06-04', 'me')
    expect(out.find(s => s.id === 'mine').isSelf).toBe(true)
    expect(out.find(s => s.id === 'theirs').isSelf).toBe(false)
  })

  it('returns [] for a day with nobody rostered, and tolerates non-arrays', () => {
    expect(teamRosterForDay([], '2026-06-04', 'me')).toEqual([])
    expect(teamRosterForDay(null, '2026-06-04', 'me')).toEqual([])
  })
})

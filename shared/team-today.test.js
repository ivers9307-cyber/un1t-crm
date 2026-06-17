import { describe, it, expect } from 'vitest'
import { groupTeamShiftsByCoach, coachSpanLabel } from './team-today'

// One shift row shaped like /api/schedule/shifts returns.
function shift(profileId, name, start, end, { startOverride, endOverride } = {}) {
  return {
    id: `${profileId}-${start}`,
    profile_id: profileId,
    profiles: { id: profileId, full_name: name },
    start_time_override: startOverride || null,
    end_time_override: endOverride || null,
    shift_templates: { name: 'Block', start_time: `${start}:00`, end_time: `${end}:00` },
  }
}

describe('groupTeamShiftsByCoach', () => {
  it('collapses a coach’s many shifts into one entry with span + count', () => {
    const rows = [
      shift('mark', 'Mark Doyle', '05:45', '08:00'),
      shift('mark', 'Mark Doyle', '08:00', '09:00'),
      shift('mark', 'Mark Doyle', '17:45', '20:30'),
      shift('lucy', 'Lucy Stapleton', '05:45', '08:00'),
    ]
    const out = groupTeamShiftsByCoach(rows)
    expect(out).toHaveLength(2)
    const mark = out.find((c) => c.profileId === 'mark')
    expect(mark).toMatchObject({ name: 'Mark Doyle', firstStart: '05:45', lastEnd: '20:30', count: 3 })
  })

  it('counts people, not shifts', () => {
    const rows = [
      shift('a', 'A', '06:00', '07:00'),
      shift('a', 'A', '08:00', '09:00'),
      shift('b', 'B', '06:00', '07:00'),
    ]
    expect(groupTeamShiftsByCoach(rows)).toHaveLength(2)
  })

  it('sorts by earliest start, then name', () => {
    const rows = [
      shift('eve', 'Eve', '17:45', '20:30'),
      shift('amy', 'Amy', '05:45', '08:00'),
      shift('bob', 'Bob', '05:45', '06:30'),
    ]
    expect(groupTeamShiftsByCoach(rows).map((c) => c.profileId)).toEqual(['amy', 'bob', 'eve'])
  })

  it('honours per-coach time overrides for the span', () => {
    const rows = [
      shift('x', 'X', '09:00', '10:00', { startOverride: '08:30:00' }),
      shift('x', 'X', '12:00', '13:30', { endOverride: '14:00:00' }),
    ]
    const x = groupTeamShiftsByCoach(rows)[0]
    expect(x.firstStart).toBe('08:30')
    expect(x.lastEnd).toBe('14:00')
  })

  it('falls back to "Coach" when the name is missing, and ignores rows with no profile_id', () => {
    const rows = [
      { id: '1', profile_id: 'p', shift_templates: { start_time: '06:00:00', end_time: '07:00:00' } },
      { id: '2', start_time_override: '06:00:00' },
    ]
    const out = groupTeamShiftsByCoach(rows)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: 'Coach', count: 1 })
  })

  it('returns [] for empty/invalid input', () => {
    expect(groupTeamShiftsByCoach(null)).toEqual([])
    expect(groupTeamShiftsByCoach(undefined)).toEqual([])
    expect(groupTeamShiftsByCoach([])).toEqual([])
  })
})

describe('coachSpanLabel', () => {
  it('renders a start – end range', () => {
    expect(coachSpanLabel({ firstStart: '05:45', lastEnd: '20:30' })).toBe('05:45 – 20:30')
  })
  it('collapses a single-time span', () => {
    expect(coachSpanLabel({ firstStart: '06:00', lastEnd: '06:00' })).toBe('06:00')
  })
  it('handles a single bound', () => {
    expect(coachSpanLabel({ firstStart: '06:00', lastEnd: null })).toBe('06:00')
    expect(coachSpanLabel(null)).toBe('')
  })
})

import { describe, it, expect } from 'vitest'
import {
  AVAILABILITY_LEAVE_SOURCE, isLeaveLikeAvailabilityRule, availabilityLeaveRow, availabilityLeaveRows,
  isAvailabilityLeave, coversDate, isOffOn, offLookup, leaveWarningLine,
} from './unavailable-days'

// Fictional ids only: the repo is public.
const P1 = 'p-1'
const P2 = 'p-2'
const dated = (over = {}) => ({
  id: 'r-1', profile_id: P1, kind: 'dated', start_date: '2026-10-11', end_date: '2026-10-13',
  all_day: true, start_time: null, end_time: null, note: null, ...over,
})

describe('AVAIL.3 D1 — which availability rules count as leave', () => {
  it('an all-day dated rule counts', () => {
    expect(isLeaveLikeAvailabilityRule(dated())).toBe(true)
  })

  it('a part-day rule, a weekly rule and a malformed rule stay advisory', () => {
    expect(isLeaveLikeAvailabilityRule(dated({ all_day: false, start_time: '06:00', end_time: '09:00' }))).toBe(false)
    expect(isLeaveLikeAvailabilityRule({ kind: 'weekly', weekday: 'mon', all_day: true, profile_id: P1 })).toBe(false)
    expect(isLeaveLikeAvailabilityRule(dated({ start_date: null }))).toBe(false)
    expect(isLeaveLikeAvailabilityRule(dated({ profile_id: null }))).toBe(false)
    expect(isLeaveLikeAvailabilityRule(null)).toBe(false)
  })
})

describe('AVAIL.3 D1 — an availability rule as a leave-shaped row', () => {
  it('reads like the approved Unavailable time off it replaces', () => {
    const row = availabilityLeaveRow(dated({ note: 'Away', profiles: { full_name: 'Coach A' } }))
    expect(row).toEqual({
      id: 'availability:r-1',
      profile_id: P1,
      type: 'unavailable',
      status: 'approved',
      start_date: '2026-10-11',
      end_date: '2026-10-13',
      total_days: 3,
      reason: 'Away',
      source: AVAILABILITY_LEAVE_SOURCE,
      profiles: { full_name: 'Coach A' },
    })
    expect(isAvailabilityLeave(row)).toBe(true)
    expect(isAvailabilityLeave({ id: 'x', status: 'approved', type: 'holiday' })).toBe(false)
  })

  it('counts calendar days across a clock change (no Date parsing of local time)', () => {
    // Irish clocks go back on 25 Oct 2026.
    expect(availabilityLeaveRow(dated({ start_date: '2026-10-24', end_date: '2026-10-26' })).total_days).toBe(3)
    expect(availabilityLeaveRow(dated({ start_date: '2026-10-15', end_date: '2026-10-15' })).total_days).toBe(1)
  })

  it('drops the rules that are not leave-like', () => {
    const rows = availabilityLeaveRows([
      dated(),
      dated({ id: 'r-2', all_day: false, start_time: '06:00', end_time: '09:00' }),
      { id: 'r-3', profile_id: P1, kind: 'weekly', weekday: 'mon', all_day: true },
    ])
    expect(rows.map((r) => r.id)).toEqual(['availability:r-1'])
    expect(availabilityLeaveRows(null)).toEqual([])
  })
})

describe('AVAIL.3 D1 — is this person off on this date (THE decision)', () => {
  const leave = [
    { id: 't-1', profile_id: P1, type: 'holiday', status: 'approved', start_date: '2026-10-01', end_date: '2026-10-02' },
    { id: 't-2', profile_id: P1, type: 'holiday', status: 'pending', start_date: '2026-10-05', end_date: '2026-10-05' },
    { id: 't-3', profile_id: P2, type: 'sick', status: 'rejected', start_date: '2026-10-11', end_date: '2026-10-11' },
  ]
  const rows = [...leave, ...availabilityLeaveRows([dated()])]

  it('approved leave and all-day availability both make a person off, both ends inclusive', () => {
    expect(isOffOn(rows, P1, '2026-10-01')).toBe(true)
    expect(isOffOn(rows, P1, '2026-10-02')).toBe(true)
    expect(isOffOn(rows, P1, '2026-10-11')).toBe(true)
    expect(isOffOn(rows, P1, '2026-10-13')).toBe(true)
  })

  it('pending or rejected leave, another person, and the days around do not', () => {
    expect(isOffOn(rows, P1, '2026-10-05')).toBe(false)
    expect(isOffOn(rows, P2, '2026-10-11')).toBe(false)
    expect(isOffOn(rows, P1, '2026-10-10')).toBe(false)
    expect(isOffOn(rows, P1, '2026-10-14')).toBe(false)
    expect(isOffOn(null, P1, '2026-10-11')).toBe(false)
  })

  it('offLookup answers the same as isOffOn', () => {
    const off = offLookup(rows)
    for (const d of ['2026-10-01', '2026-10-05', '2026-10-11', '2026-10-14']) {
      expect(off(P1, d)).toBe(isOffOn(rows, P1, d))
      expect(off(P2, d)).toBe(isOffOn(rows, P2, d))
    }
  })

  it('coversDate needs an approved row', () => {
    expect(coversDate(rows[0], '2026-10-01')).toBe(true)
    expect(coversDate(rows[1], '2026-10-05')).toBe(false)
    expect(coversDate(null, '2026-10-05')).toBe(false)
  })
})

describe('AVAIL.3 D1 — the assign warning line', () => {
  it('says approved leave as before, and says availability for an availability row', () => {
    const t = { type: 'holiday', status: 'approved', start_date: '2026-10-01', end_date: '2026-10-02' }
    expect(leaveWarningLine('Coach A', t)).toBe('Coach A has approved holiday from 2026-10-01 to 2026-10-02')
    const a = availabilityLeaveRow(dated())
    expect(leaveWarningLine('Coach A', a)).toBe('Coach A can’t work from 2026-10-11 to 2026-10-13 (My availability)')
    expect(leaveWarningLine(null, a)).toMatch(/^This coach can’t work/)
  })

  it('has no em dashes', () => {
    expect(leaveWarningLine('A', availabilityLeaveRow(dated()))).not.toMatch(/—/)
  })
})

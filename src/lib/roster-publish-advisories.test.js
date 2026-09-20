// COPYLEAVE.1 — what the publish preview warns about besides staffing gaps.
// Pure, so no Supabase mock. Fixtures are invented: the repo is public.
import { describe, it, expect } from 'vitest'
import { leaveCovering, leaveClashes, doubleBookings } from './roster-publish-advisories'

const TODAY = '2026-05-01'
const PERIOD = { from: '2026-05-04', to: '2026-05-10', todayIso: TODAY }

const asg = (profileId, name, over = {}) => ({
  profile_id: profileId, status: 'scheduled', start_time_override: null, end_time_override: null,
  profiles: { full_name: name }, ...over,
})
const blk = (id, date, start, end, assignments, name = 'Morning') => ({
  id, location_id: 'loc1', block_date: date, start_time: start, end_time: end,
  shift_templates: { name }, shift_assignments: assignments,
})
// A row from ANOTHER studio, in the shape loadBudgetContext reads it.
const other = (profileId, date, start, end, over = {}) => ({
  id: `oa-${profileId}-${date}-${start}`, profile_id: profileId, status: 'scheduled',
  start_time_override: null, end_time_override: null,
  shift_blocks: { id: `ob-${date}-${start}`, location_id: 'loc2', block_date: date, start_time: start, end_time: end, shift_templates: { name: 'Open Gym' }, locations: { name: 'Studio B' } },
  ...over,
})
const leaveMap = (rows) => {
  const m = new Map()
  for (const r of rows) { if (!m.has(r.profile_id)) m.set(r.profile_id, []); m.get(r.profile_id).push(r) }
  return m
}

describe('leaveCovering', () => {
  const m = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-04', end_date: '2026-05-06' }])
  it('returns the covering row, both ends inclusive', () => {
    expect(leaveCovering(m, 'a', '2026-05-04')?.id).toBe('l1')
    expect(leaveCovering(m, 'a', '2026-05-06')?.id).toBe('l1')
  })
  it('returns null outside the range, for another coach, and for no map', () => {
    expect(leaveCovering(m, 'a', '2026-05-07')).toBeNull()
    expect(leaveCovering(m, 'b', '2026-05-05')).toBeNull()
    expect(leaveCovering(null, 'a', '2026-05-05')).toBeNull()
  })
})

describe('leaveClashes', () => {
  const leaveByProfile = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-05', end_date: '2026-05-06' }])

  it('lists a coach rostered on a day they have approved leave, with the hours they are down for', () => {
    const out = leaveClashes(
      [blk('b1', '2026-05-05', '06:00:00', '09:00:00', [asg('a', 'Coach A', { end_time_override: '08:00:00' }), asg('b', 'Coach B')])],
      { ...PERIOD, leaveByProfile },
    )
    expect(out).toEqual([{
      block_id: 'b1', block_date: '2026-05-05', start_time: '06:00:00', end_time: '08:00:00', name: 'Morning',
      profile_id: 'a', coach_name: 'Coach A', leave_start: '2026-05-05', leave_end: '2026-05-06',
    }])
  })

  it('ignores a cancelled assignment, a block outside the period, and a block before today', () => {
    const blocks = [
      blk('cancelled', '2026-05-05', '06:00', '09:00', [asg('a', 'Coach A', { status: 'cancelled' })]),
      blk('outside', '2026-05-12', '06:00', '09:00', [asg('a', 'Coach A')]),
      blk('past', '2026-05-05', '06:00', '09:00', [asg('a', 'Coach A')]),
    ]
    const wide = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-01', end_date: '2026-05-31' }])
    expect(leaveClashes(blocks.slice(0, 2), { ...PERIOD, leaveByProfile: wide })).toEqual([])
    expect(leaveClashes([blocks[2]], { ...PERIOD, todayIso: '2026-05-06', leaveByProfile: wide })).toEqual([])
  })

  it('falls back to "Coach" when the name was not embedded, and sorts by date then start', () => {
    const wide = leaveMap([{ id: 'l1', profile_id: 'a', start_date: '2026-05-01', end_date: '2026-05-31' }])
    const out = leaveClashes([
      blk('late', '2026-05-06', '17:00', '18:00', [{ profile_id: 'a', status: 'scheduled' }]),
      blk('early', '2026-05-06', '06:00', '07:00', [{ profile_id: 'a', status: 'scheduled' }]),
      blk('first', '2026-05-04', '09:00', '10:00', [{ profile_id: 'a', status: 'scheduled' }]),
    ], { ...PERIOD, leaveByProfile: wide })
    expect(out.map((c) => c.block_id)).toEqual(['first', 'early', 'late'])
    expect(out[0].coach_name).toBe('Coach')
  })
})

describe('doubleBookings', () => {
  it('pairs two overlapping shifts of one coach at THIS studio', () => {
    const out = doubleBookings([
      blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')], 'Morning'),
      blk('b2', '2026-05-05', '10:00', '12:00', [asg('a', 'Coach A')], 'Midday'),
    ], [], PERIOD)
    expect(out).toEqual([{
      profile_id: 'a', coach_name: 'Coach A', block_date: '2026-05-05',
      first: { block_id: 'b1', name: 'Morning', start_time: '09:00', end_time: '11:00', location_name: null },
      second: { block_id: 'b2', name: 'Midday', start_time: '10:00', end_time: '12:00', location_name: null },
    }])
  })

  it('back-to-back shifts are NOT a double booking (touching endpoints)', () => {
    expect(doubleBookings([
      blk('b1', '2026-05-05', '09:00', '10:00', [asg('a', 'Coach A')]),
      blk('b2', '2026-05-05', '10:00', '11:00', [asg('a', 'Coach A')]),
    ], [], PERIOD)).toEqual([])
  })

  it('compares the hours each coach is actually down for (their override), not the block\'s', () => {
    // The block runs 09-12 but Coach A is only on it 09-10, so 10-11 elsewhere is fine.
    expect(doubleBookings([
      blk('b1', '2026-05-05', '09:00', '12:00', [asg('a', 'Coach A', { end_time_override: '10:00:00' })]),
      blk('b2', '2026-05-05', '10:00', '11:00', [asg('a', 'Coach A')]),
    ], [], PERIOD)).toEqual([])
  })

  it('finds a clash with a shift at ANOTHER studio and names that studio', () => {
    const out = doubleBookings(
      [blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')])],
      [other('a', '2026-05-05', '10:30:00', '12:00:00')],
      PERIOD,
    )
    expect(out).toHaveLength(1)
    expect(out[0].first).toMatchObject({ block_id: 'b1', location_name: null })
    expect(out[0].second).toMatchObject({ name: 'Open Gym', start_time: '10:30', end_time: '12:00', location_name: 'Studio B' })
  })

  it('never reports a pair that is ENTIRELY at another studio: not this publish\'s business', () => {
    expect(doubleBookings(
      [blk('b1', '2026-05-05', '06:00', '07:00', [asg('a', 'Coach A')])],
      [other('a', '2026-05-05', '10:00', '12:00'), other('a', '2026-05-05', '11:00', '13:00')],
      PERIOD,
    )).toEqual([])
  })

  it('ignores cancelled rows on either side, other days, other coaches, and days outside the period', () => {
    expect(doubleBookings(
      [
        blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A'), asg('c', 'Coach C', { status: 'cancelled' })]),
        blk('b2', '2026-05-05', '10:00', '12:00', [asg('b', 'Coach B'), asg('c', 'Coach C')]),
        blk('b3', '2026-05-12', '09:00', '11:00', [asg('d', 'Coach D')]),
        blk('b4', '2026-05-12', '10:00', '12:00', [asg('d', 'Coach D')]),
      ],
      [other('a', '2026-05-05', '09:30', '10:30', { status: 'cancelled' }), other('a', '2026-05-06', '09:30', '10:30')],
      PERIOD,
    )).toEqual([])
  })

  it('tolerates a null other-studio list (the cross-studio read failed)', () => {
    expect(doubleBookings([blk('b1', '2026-05-05', '09:00', '11:00', [asg('a', 'Coach A')])], null, PERIOD)).toEqual([])
  })
})

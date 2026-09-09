// SCHEDULE-DOUBLE-BOOKING.1 — unit tests for the overlap helpers.
import { describe, it, expect } from 'vitest'
import { coachConflictsForBlock, fmtTime, formatTime12h, timeRangesOverlap } from './schedule-overlap'

describe('fmtTime', () => {
  it('trims HH:MM:SS to HH:MM', () => {
    expect(fmtTime('09:30:00')).toBe('09:30')
    expect(fmtTime('17:00')).toBe('17:00')
  })
  it('handles null/empty', () => {
    expect(fmtTime(null)).toBe('')
    expect(fmtTime(undefined)).toBe('')
  })
})

describe('timeRangesOverlap', () => {
  it('detects a genuine overlap', () => {
    expect(timeRangesOverlap('09:00:00', '10:00:00', '09:30:00', '10:30:00')).toBe(true)
  })
  it('detects full containment', () => {
    expect(timeRangesOverlap('09:00', '12:00', '10:00', '11:00')).toBe(true)
    expect(timeRangesOverlap('10:00', '11:00', '09:00', '12:00')).toBe(true)
  })
  it('identical ranges overlap', () => {
    expect(timeRangesOverlap('09:30', '10:30', '09:30', '10:30')).toBe(true)
  })
  it('touching endpoints do NOT count as overlap', () => {
    // a ends exactly when b starts
    expect(timeRangesOverlap('09:00', '10:00', '10:00', '11:00')).toBe(false)
    expect(timeRangesOverlap('10:00', '11:00', '09:00', '10:00')).toBe(false)
  })
  it('disjoint ranges do not overlap', () => {
    expect(timeRangesOverlap('09:00', '10:00', '14:00', '15:00')).toBe(false)
  })
  it('ignores sub-minute precision (minute granularity)', () => {
    // These overlap only in the seconds (10:00:10 < 10:00:45); at minute
    // granularity they merely touch, so no overlap is reported.
    expect(timeRangesOverlap('09:00:00', '10:00:45', '10:00:10', '11:00:00')).toBe(false)
    // A genuine minute-level overlap is still detected regardless of seconds.
    expect(timeRangesOverlap('09:00:30', '10:00:30', '09:30:00', '10:30:00')).toBe(true)
  })
  it('returns false for missing inputs', () => {
    expect(timeRangesOverlap('', '10:00', '09:30', '10:30')).toBe(false)
    expect(timeRangesOverlap('09:00', '10:00', null, '10:30')).toBe(false)
  })
  it('returns false for zero-length or overnight ranges (out of scope)', () => {
    expect(timeRangesOverlap('10:00', '10:00', '09:00', '11:00')).toBe(false) // zero-length
    expect(timeRangesOverlap('22:00', '06:00', '23:00', '23:30')).toBe(false) // overnight a
  })
})

// ROSTER-FIX.6c — the 12-hour label three schedule screens each had their own
// copy of. Pinned here because it is now shared: a change to it moves the
// calendar, the template manager and the swap list at once.
describe('formatTime12h', () => {
  it('drops :00 minutes', () => {
    expect(formatTime12h('09:00:00')).toBe('9am')
    expect(formatTime12h('17:00')).toBe('5pm')
  })
  it('keeps non-zero minutes', () => {
    expect(formatTime12h('09:30:00')).toBe('9:30am')
    expect(formatTime12h('18:45')).toBe('6:45pm')
  })
  it('midnight is 12am and noon is 12pm', () => {
    expect(formatTime12h('00:00')).toBe('12am')
    expect(formatTime12h('12:00')).toBe('12pm')
    expect(formatTime12h('00:15')).toBe('12:15am')
  })
  it('returns empty for a missing time', () => {
    expect(formatTime12h(null)).toBe('')
    expect(formatTime12h('')).toBe('')
    expect(formatTime12h(undefined)).toBe('')
  })
})

// ROSTER-FIX.6c — the assign picker's advisory. The overlap helpers above have
// existed since SCHEDULE-DOUBLE-BOOKING.1 and were never imported by a client
// component, so the one place an operator picks a coach said nothing about the
// shift that coach is already on, or the leave they are already approved for.
describe('coachConflictsForBlock', () => {
  const BLOCK = {
    id: 'b-target',
    block_date: '2026-05-06',
    start_time: '10:00:00',
    end_time: '12:00:00',
    shift_assignments: [],
  }
  const other = (over) => ({
    id: 'b-other',
    block_date: '2026-05-06',
    start_time: '09:30:00',
    end_time: '11:00:00',
    shift_templates: { name: 'Morning HIIT' },
    shift_assignments: [{ id: 'a1', profile_id: 'c1', status: 'scheduled', ...over }],
  })

  it('reports no conflict when the coach is on nothing that day', () => {
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK], timeOff: [] }))
      .toEqual({ clash: null, onLeave: false })
  })

  it('names the shift the coach already has that overlaps', () => {
    const res = coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, other()], timeOff: [] })
    expect(res.clash).toEqual({ blockId: 'b-other', name: 'Morning HIIT', startTime: '09:30', endTime: '11:00' })
  })

  it('ignores a shift on a different day', () => {
    const elsewhere = { ...other(), block_date: '2026-05-07' }
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, elsewhere], timeOff: [] }).clash).toBeNull()
  })

  it('ignores a shift that only touches endpoints', () => {
    const touching = { ...other(), start_time: '08:00:00', end_time: '10:00:00' }
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, touching], timeOff: [] }).clash).toBeNull()
  })

  it('ignores a cancelled assignment', () => {
    const dropped = other({ status: 'cancelled' })
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, dropped], timeOff: [] }).clash).toBeNull()
  })

  it('ignores the block being assigned, so an existing row on it is not its own clash', () => {
    const self = { ...BLOCK, shift_assignments: [{ id: 'a0', profile_id: 'c1', status: 'scheduled' }] }
    expect(coachConflictsForBlock({ coachId: 'c1', block: self, blocks: [self], timeOff: [] }).clash).toBeNull()
  })

  it('honours the other assignment own adjusted window', () => {
    // The coach was moved off the overlap, so there is no clash any more.
    const moved = other({ start_time_override: '07:00:00', end_time_override: '09:00:00' })
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, moved], timeOff: [] }).clash).toBeNull()
    // And the reverse: an adjustment that creates one is caught.
    const stretched = { ...other({ start_time_override: '11:30:00', end_time_override: '13:00:00' }), start_time: '06:00:00', end_time: '07:00:00' }
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, stretched], timeOff: [] }).clash).not.toBeNull()
  })

  it('falls back to Shift when the other block has no template name', () => {
    const unnamed = { ...other(), shift_templates: null }
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK, unnamed], timeOff: [] }).clash.name).toBe('Shift')
  })

  it('flags approved leave covering the block date', () => {
    const timeOff = [{ id: 't1', profile_id: 'c1', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-08' }]
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK], timeOff }).onLeave).toBe(true)
  })

  it('ignores leave that is not approved, another coach leave, and leave outside the date', () => {
    const rows = [
      { id: 't1', profile_id: 'c1', status: 'pending', start_date: '2026-05-04', end_date: '2026-05-08' },
      { id: 't2', profile_id: 'c2', status: 'approved', start_date: '2026-05-04', end_date: '2026-05-08' },
      { id: 't3', profile_id: 'c1', status: 'approved', start_date: '2026-05-07', end_date: '2026-05-08' },
    ]
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK, blocks: [BLOCK], timeOff: rows }).onLeave).toBe(false)
  })

  it('tolerates missing inputs rather than throwing inside a render', () => {
    expect(coachConflictsForBlock({ coachId: 'c1', block: BLOCK })).toEqual({ clash: null, onLeave: false })
    expect(coachConflictsForBlock({ coachId: null, block: BLOCK, blocks: [other()], timeOff: [] })).toEqual({ clash: null, onLeave: false })
    expect(coachConflictsForBlock({ coachId: 'c1', block: null, blocks: [other()], timeOff: [] })).toEqual({ clash: null, onLeave: false })
  })
})

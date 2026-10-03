// Tests for src/lib/schedule-overview.js (mig 125).
// Pure helpers — no DB mock needed.

import { describe, it, expect } from 'vitest'
import {
  eventTypeHasWindowForDate,
  sumStaffRequired,
  aggregateDayDemand,
  classifyDayLoad,
  leaveOnDate,
  underMinEntry,
} from './schedule-overview.js'

describe('eventTypeHasWindowForDate', () => {
  const monAvailability = {
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    wed: null,
    sat: { start: null, end: null },
  }

  it('true when day-of-week has a complete window', () => {
    // 2026-05-11 is a Monday
    expect(eventTypeHasWindowForDate(monAvailability, '2026-05-11')).toBe(true)
    // 2026-05-12 is a Tuesday
    expect(eventTypeHasWindowForDate(monAvailability, '2026-05-12')).toBe(true)
  })

  it('false when day-of-week is null', () => {
    // 2026-05-13 is a Wednesday → wed: null
    expect(eventTypeHasWindowForDate(monAvailability, '2026-05-13')).toBe(false)
  })

  it('false when day-of-week is missing entirely', () => {
    // 2026-05-15 is a Friday → no fri key
    expect(eventTypeHasWindowForDate(monAvailability, '2026-05-15')).toBe(false)
  })

  it('false when window is partially null (start: null)', () => {
    // 2026-05-16 is a Saturday → start: null
    expect(eventTypeHasWindowForDate(monAvailability, '2026-05-16')).toBe(false)
  })

  it('false for missing/invalid input', () => {
    expect(eventTypeHasWindowForDate(null, '2026-05-11')).toBe(false)
    expect(eventTypeHasWindowForDate(undefined, '2026-05-11')).toBe(false)
    expect(eventTypeHasWindowForDate(monAvailability, null)).toBe(false)
    expect(eventTypeHasWindowForDate(monAvailability, 'not-a-date')).toBe(false)
  })
})

describe('sumStaffRequired', () => {
  it('returns 0 for empty / missing input', () => {
    expect(sumStaffRequired([])).toBe(0)
    expect(sumStaffRequired(null)).toBe(0)
    expect(sumStaffRequired(undefined)).toBe(0)
  })

  it('sums explicit values', () => {
    expect(sumStaffRequired([
      { staff_required: 4 },
      { staff_required: 1 },
      { staff_required: 2 },
    ])).toBe(7)
  })

  it('treats 0 as exempt (covered by another role)', () => {
    expect(sumStaffRequired([
      { staff_required: 1 },
      { staff_required: 0 },  // skipped
      { staff_required: 1 },
    ])).toBe(2)
  })

  it('treats null/missing as DB default of 1', () => {
    expect(sumStaffRequired([
      { staff_required: null },  // → 1
      { staff_required: 4 },
      {},                        // → 1 (missing field)
    ])).toBe(6)
  })

  it('skips null entries defensively', () => {
    expect(sumStaffRequired([
      { staff_required: 2 },
      null,
      { staff_required: 3 },
    ])).toBe(5)
  })
})

describe('aggregateDayDemand', () => {
  const monAvailability = { mon: { start: '09:00', end: '17:00' } }
  const wedAvailability = { wed: { start: '09:00', end: '17:00' } }

  it('sums event demand + matching event_type demand', () => {
    expect(aggregateDayDemand({
      // 2026-05-11 is a Monday
      date: '2026-05-11',
      events: [{ staff_required: 4 }, { staff_required: 1 }],
      event_types: [
        { staff_required: 1, availability: monAvailability },  // applies (Mon)
        { staff_required: 1, availability: wedAvailability },  // doesn't apply
      ],
    })).toBe(6)  // 4+1 events + 1 monday event_type
  })

  it('zero when nothing is scheduled or available', () => {
    expect(aggregateDayDemand({
      date: '2026-05-11',
      events: [],
      event_types: [],
    })).toBe(0)
  })

  it('only counts event_types with a window today', () => {
    expect(aggregateDayDemand({
      date: '2026-05-13',  // Wednesday
      events: [],
      event_types: [
        { staff_required: 1, availability: monAvailability },  // doesn't apply
        { staff_required: 2, availability: wedAvailability },  // applies
      ],
    })).toBe(2)
  })
})

describe('classifyDayLoad', () => {
  it('green when no demand', () => {
    expect(classifyDayLoad({ demand: 0, staff_scheduled: 0, staff_on_leave: 0 })).toBe('green')
    expect(classifyDayLoad({ demand: 0, staff_scheduled: 5, staff_on_leave: 1 })).toBe('green')
  })

  it('green when supply >= demand', () => {
    expect(classifyDayLoad({ demand: 3, staff_scheduled: 3, staff_on_leave: 0 })).toBe('green')
    expect(classifyDayLoad({ demand: 3, staff_scheduled: 5, staff_on_leave: 0 })).toBe('green')
  })

  it('amber when supply < demand but > 0', () => {
    expect(classifyDayLoad({ demand: 5, staff_scheduled: 3, staff_on_leave: 0 })).toBe('amber')
    expect(classifyDayLoad({ demand: 4, staff_scheduled: 5, staff_on_leave: 2 })).toBe('amber')
  })

  it('red when demand exists and effective supply is 0', () => {
    expect(classifyDayLoad({ demand: 1, staff_scheduled: 0, staff_on_leave: 0 })).toBe('red')
    expect(classifyDayLoad({ demand: 5, staff_scheduled: 2, staff_on_leave: 2 })).toBe('red')
    // All scheduled staff are on leave → effective supply 0 with demand
    expect(classifyDayLoad({ demand: 1, staff_scheduled: 3, staff_on_leave: 3 })).toBe('red')
  })

  it('clamps negative effective supply to 0 (more on leave than scheduled — defensive)', () => {
    expect(classifyDayLoad({ demand: 1, staff_scheduled: 1, staff_on_leave: 5 })).toBe('red')
  })

  // SHIFTMIN.1 — blocks_below_min escalation. Even when day-level
  // supply vs. event demand is fine, undermanned individual shifts
  // flip the classification to amber so operators notice before
  // the morning of.
  describe('blocks_below_min escalation', () => {
    it('flips green → amber when at least one block is under min', () => {
      expect(classifyDayLoad({ demand: 0, staff_scheduled: 5, staff_on_leave: 0, blocks_below_min: 1 })).toBe('amber')
      // Even with demand fully covered, an undermanned block still escalates.
      expect(classifyDayLoad({ demand: 3, staff_scheduled: 5, staff_on_leave: 0, blocks_below_min: 2 })).toBe('amber')
    })

    it('stays green when no blocks are under min', () => {
      expect(classifyDayLoad({ demand: 0, staff_scheduled: 5, staff_on_leave: 0, blocks_below_min: 0 })).toBe('green')
      // Omitted blocks_below_min should be treated as 0 (backwards compat).
      expect(classifyDayLoad({ demand: 0, staff_scheduled: 5, staff_on_leave: 0 })).toBe('green')
    })

    it('red still wins over under-min when both apply (supply=0, demand>0, blocks under)', () => {
      // The day is "uncovered" first; undermanned-block detail is secondary.
      expect(classifyDayLoad({ demand: 3, staff_scheduled: 0, staff_on_leave: 0, blocks_below_min: 2 })).toBe('red')
    })

    it('demand-vs-supply amber still wins over green when blocks_below_min is 0', () => {
      // Under-demand supply already classifies as amber; this just
      // confirms the existing path isn't broken by the new arg.
      expect(classifyDayLoad({ demand: 5, staff_scheduled: 3, staff_on_leave: 0, blocks_below_min: 0 })).toBe('amber')
    })
  })
})

// ROSTERLOOK.1 — two overlapping requests from one person put their name in
// the day dialog's "On leave" list twice (seen live: every day of a week).
describe('leaveOnDate', () => {
  const row = (profile_id, start_date, end_date, full_name) => ({ profile_id, start_date, end_date, profiles: { full_name } })

  it('names each PERSON once, however many of their requests cover the day', () => {
    const out = leaveOnDate([
      row('p1', '2026-09-21', '2026-09-27', 'Coach A'),
      row('p1', '2026-09-23', '2026-09-24', 'Coach A'),
      row('p2', '2026-09-23', '2026-09-23', 'Coach B'),
    ], '2026-09-23')
    expect(out.names).toEqual(['Coach A', 'Coach B'])
    expect(out.profileIds).toEqual(['p1', 'p2'])
  })

  it('dedupes by profile, not by name: two people who share a name are two people', () => {
    const out = leaveOnDate([
      row('p1', '2026-09-23', '2026-09-23', 'Coach A'),
      row('p2', '2026-09-23', '2026-09-23', 'Coach A'),
    ], '2026-09-23')
    expect(out.names).toEqual(['Coach A', 'Coach A'])
  })

  it('ignores requests that do not cover the day, tolerates a missing name and null input', () => {
    expect(leaveOnDate([row('p1', '2026-09-21', '2026-09-22', 'Coach A')], '2026-09-23').names).toEqual([])
    expect(leaveOnDate([{ profile_id: 'p3', start_date: '2026-09-23', end_date: '2026-09-23' }], '2026-09-23').names).toEqual(['Unknown'])
    expect(leaveOnDate(null, '2026-09-23')).toEqual({ names: [], profileIds: [] })
  })
})

describe('underMinEntry (SHIFTMIN.1 / SHIFTTYPE.1)', () => {
  const b = (over = {}) => ({
    id: 'b1', block_date: '2026-09-22', start_time: '09:30:00', end_time: '10:30:00', min_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class' },
    shift_assignments: [{ profile_id: 'p1', status: 'scheduled' }, { profile_id: 'p2', status: 'cancelled' }],
    ...over,
  })

  it('names a class block below its minimum, counting live coaches only', () => {
    expect(underMinEntry(b())).toEqual({ id: 'b1', label: 'Morning', time: '09:30–10:30', assigned: 1, min: 2 })
  })

  it('is null at or above the minimum, and with no minimum', () => {
    expect(underMinEntry(b({ min_coaches: 1 }))).toBeNull()
    expect(underMinEntry(b({ min_coaches: 0 }))).toBeNull()
  })

  it('is null for an admin block, even one still carrying a minimum', () => {
    expect(underMinEntry(b({ shift_templates: { name: 'Admin', kind: 'admin' } }))).toBeNull()
  })
})

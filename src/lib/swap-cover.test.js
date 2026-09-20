// src/lib/swap-cover.test.js
// COVERLOOP.1 — the pure half of the cover loop. No DB, no clock.
import { describe, it, expect } from 'vitest'
import { shiftDayLabel, shiftWhenLabel, openPoolRecipients } from './swap-cover'

const LOC = 'loc-1'          // the swap's studio
const SIBLING = 'loc-2'      // another studio in the SAME organisation
const FOREIGN = 'loc-x'      // a studio in ANOTHER organisation

// 2026-09-24 is a Thursday.
const BLOCK = { id: 'blk-1', block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00' }

// A profile_locations row, the shape the server half reads.
const member = (profile_id, over = {}) => ({
  profile_id, location_id: LOC, role: 'staff',
  profiles: { id: profile_id, role: 'staff', active: true },
  ...over,
})
const leave = (profile_id, over = {}) => ({
  id: `t-${profile_id}`, profile_id, type: 'holiday', status: 'approved',
  start_date: '2026-09-24', end_date: '2026-09-24', total_days: 1, ...over,
})
// Another shift that day, on a DIFFERENT block. Defaults to a sibling studio
// in the same organisation: a coach cannot be in two places at once.
const shift = (profile_id, start, end, over = {}) => ({
  id: `a-${profile_id}`, profile_id, block_id: 'blk-other', status: 'scheduled',
  start_time_override: null, end_time_override: null,
  shift_blocks: {
    id: 'blk-other', location_id: SIBLING, block_date: '2026-09-24', start_time: start, end_time: end,
    rosters: { status: 'published' },
  },
  ...over,
})

describe('shiftDayLabel', () => {
  it.each([
    ['2026-09-24', 'Thu 24 Sep'],
    ['2099-01-01', 'Thu 1 Jan'],
    // The day the clocks go back. A calendar date has no timezone, so this
    // must not slide to Saturday on a server west of Dublin.
    ['2026-10-25', 'Sun 25 Oct'],
    ['2026-02-31', ''],
    ['next week', ''],
    [null, ''],
  ])('%s -> "%s"', (input, expected) => {
    expect(shiftDayLabel(input)).toBe(expected)
  })
})

describe('shiftWhenLabel', () => {
  it.each([
    [BLOCK, 'Thu 24 Sep, 06:00 to 07:00'],
    [{ block_date: '2026-09-24' }, 'Thu 24 Sep'],
    [{ start_time: '06:00:00', end_time: '07:00:00' }, '06:00 to 07:00'],
    [null, 'an upcoming shift'],
  ])('%j -> "%s"', (block, expected) => {
    expect(shiftWhenLabel(block)).toBe(expected)
  })
})

describe('openPoolRecipients', () => {
  const base = {
    locationId: LOC,
    orgLocationIds: [LOC, SIBLING],
    members: [member('req'), member('a'), member('b')],
    managerIds: [],
    requesterId: 'req',
    block: BLOCK,
    timeOff: [],
    assignments: [],
  }

  it.each([
    {
      name: 'includes a coach with NO shift that day (the likeliest cover; the old rule skipped them)',
      input: {},
      expected: ['a', 'b'],
    },
    {
      name: 'never the requester',
      input: { members: [member('req')] },
      expected: [],
    },
    {
      name: 'never a manager: swap_open already told them (the resolver\'s list)',
      input: { managerIds: ['a'] },
      expected: ['b'],
    },
    {
      name: 'never a manager, even when the resolver\'s list came back empty: the link\'s own role says so',
      input: { members: [member('req'), member('a', { role: 'head_coach' }), member('b')] },
      expected: ['b'],
    },
    {
      name: 'never a master (they are in every manager fan-out)',
      input: { members: [member('req'), member('a', { profiles: { id: 'a', role: 'master', active: true } }), member('b')] },
      expected: ['b'],
    },
    {
      name: 'not a DEACTIVATED profile',
      input: { members: [member('req'), member('a', { profiles: { id: 'a', role: 'staff', active: false } }), member('b')] },
      expected: ['b'],
    },
    {
      name: 'a link with no profile embed is not proof of an active coach',
      input: { members: [member('req'), member('a', { profiles: null }), member('b')] },
      expected: ['b'],
    },
    {
      name: 'not a coach at a SIBLING studio who is not a member here',
      input: { members: [member('req'), member('a', { location_id: SIBLING }), member('b')] },
      expected: ['b'],
    },
    {
      name: 'a coach linked to BOTH studios is a member here, whichever row arrives first',
      input: { members: [member('a', { location_id: SIBLING }), member('a'), member('req')] },
      expected: ['a'],
    },
    {
      name: 'not a coach on approved leave that day',
      input: { timeOff: [leave('a')] },
      expected: ['b'],
    },
    {
      name: 'not a coach whose multi-day approved leave covers the date',
      input: { timeOff: [leave('a', { start_date: '2026-09-22', end_date: '2026-09-26', total_days: 5 })] },
      expected: ['b'],
    },
    {
      name: 'a HALF day (single-day request, total_days < 1) does NOT exclude: they may be free for the shift',
      input: { timeOff: [leave('a', { total_days: 0.5 })] },
      expected: ['a', 'b'],
    },
    {
      name: 'a half day arriving as the string PostgREST sends for NUMERIC does not exclude either',
      input: { timeOff: [leave('a', { total_days: '0.5' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'a multi-day request with a fractional total still excludes (which end is the half day is unknown)',
      input: { timeOff: [leave('a', { start_date: '2026-09-23', end_date: '2026-09-24', total_days: 1.5 })] },
      expected: ['b'],
    },
    {
      name: 'a single-day request with no readable total_days is treated as a whole day',
      input: { timeOff: [leave('a', { total_days: null })] },
      expected: ['b'],
    },
    {
      name: 'PENDING leave does not exclude',
      input: { timeOff: [leave('a', { status: 'pending' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'leave that ended the day before does not exclude',
      input: { timeOff: [leave('a', { start_date: '2026-09-20', end_date: '2026-09-23', total_days: 4 })] },
      expected: ['a', 'b'],
    },
    {
      name: 'not a coach on an overlapping live shift, at any studio in the organisation',
      input: { assignments: [shift('a', '06:30:00', '08:00:00')] },
      expected: ['b'],
    },
    {
      name: 'a `swapped` assignment is LIVE (owned by the taker) and excludes',
      input: { assignments: [shift('a', '06:30:00', '08:00:00', { status: 'swapped' })] },
      expected: ['b'],
    },
    {
      name: 'the overlap is judged on the assignment override, not the block default',
      input: { assignments: [shift('a', '08:00:00', '09:00:00', { start_time_override: '06:30:00' })] },
      expected: ['b'],
    },
    {
      name: 'a shift that only TOUCHES (06:00-07:00 then 07:00-08:00) does not exclude',
      input: { assignments: [shift('a', '07:00:00', '08:00:00')] },
      expected: ['a', 'b'],
    },
    {
      name: 'a shift that only touches on the other side (05:00-06:00) does not exclude',
      input: { assignments: [shift('a', '05:00:00', '06:00:00')] },
      expected: ['a', 'b'],
    },
    {
      name: 'a cancelled tombstone does not exclude',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { status: 'cancelled' })] },
      expected: ['a', 'b'],
    },
    {
      name: 'not a coach already on THIS block (the approve RPC would refuse them: swap_conflict)',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { block_id: 'blk-1', shift_blocks: { ...BLOCK, location_id: LOC, rosters: { status: 'published' } } })] },
      expected: ['b'],
    },
    {
      name: 'an assignment on another day is ignored',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { shift_blocks: { id: 'blk-other', location_id: SIBLING, block_date: '2026-09-25', start_time: '06:00:00', end_time: '07:00:00' } })] },
      expected: ['a', 'b'],
    },
    {
      name: 'TENANCY: a shift at another ORGANISATION\'s studio is never used, even if a row were to arrive',
      input: { assignments: [shift('a', '06:00:00', '07:00:00', { shift_blocks: { id: 'blk-f', location_id: FOREIGN, block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00' } })] },
      expected: ['a', 'b'],
    },
    {
      name: 'TENANCY: with no organisation list, only this studio\'s shifts are used',
      input: { orgLocationIds: undefined, assignments: [shift('a', '06:30:00', '08:00:00')] },
      expected: ['a', 'b'],
    },
    {
      name: 'duplicates and blanks in the member list are dropped',
      input: { members: [member('a'), member('a'), null, member(null), member('b'), member('req')] },
      expected: ['a', 'b'],
    },
    {
      name: 'no block date: nobody (nothing to describe, nothing to check)',
      input: { block: { id: 'blk-1' } },
      expected: [],
    },
    {
      name: 'no studio: nobody',
      input: { locationId: null },
      expected: [],
    },
  ])('$name', ({ input, expected }) => {
    expect(openPoolRecipients({ ...base, ...input })).toEqual(expected)
  })

  // DEGRADED mode — what the server half asks for when a read it needs failed.
  // The audience may only SHRINK to (at most) what the pre-COVERLOOP rule
  // reached: coaches with a live shift at THIS studio that day on a PUBLISHED
  // roster. Every other exclusion still applies.
  describe('rosteredHereOnly (a read failed)', () => {
    const here = (profile_id, start, end, over = {}) => shift(profile_id, start, end, {
      shift_blocks: { id: `blk-${profile_id}`, location_id: LOC, block_date: '2026-09-24', start_time: start, end_time: end, rosters: { status: 'published' } },
      block_id: `blk-${profile_id}`,
      ...over,
    })

    it.each([
      {
        name: 'only a coach working HERE that day on a published roster; the off-day coach is dropped',
        input: { assignments: [here('a', '09:00:00', '10:00:00')] },
        expected: ['a'],
      },
      {
        name: 'a shift at a sibling studio does not qualify',
        input: { assignments: [shift('a', '09:00:00', '10:00:00')] },
        expected: [],
      },
      {
        name: 'a shift here on a DRAFT roster does not qualify (D1)',
        input: { assignments: [here('a', '09:00:00', '10:00:00', { shift_blocks: { id: 'blk-a', location_id: LOC, block_date: '2026-09-24', start_time: '09:00:00', end_time: '10:00:00', rosters: { status: 'draft' } } })] },
        expected: [],
      },
      {
        name: 'a cancelled shift here does not qualify',
        input: { assignments: [here('a', '09:00:00', '10:00:00', { status: 'cancelled' })] },
        expected: [],
      },
      {
        name: 'working here but overlapping: still excluded',
        input: { assignments: [here('a', '06:30:00', '08:00:00')] },
        expected: [],
      },
      {
        name: 'working here but a manager: still excluded',
        input: { managerIds: ['a'], assignments: [here('a', '09:00:00', '10:00:00')] },
        expected: [],
      },
      {
        name: 'no assignment rows at all: nobody',
        input: {},
        expected: [],
      },
    ])('$name', ({ input, expected }) => {
      expect(openPoolRecipients({ ...base, rosteredHereOnly: true, ...input })).toEqual(expected)
    })
  })
})

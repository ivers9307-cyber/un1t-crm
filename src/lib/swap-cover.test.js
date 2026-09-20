// src/lib/swap-cover.test.js
// COVERLOOP.1 — the pure half of the cover loop. No DB, no clock.
import { describe, it, expect } from 'vitest'
import {
  shiftDayLabel, shiftWhenLabel, openPoolRecipients, openPoolPayload,
  inStaffPushHours, STAFF_PUSH_HOURS,
  coverSweepAction, coverNudgePayload, swapExpiryNotices, SWAP_EXPIRY_NOTES,
  SWAP_EXPIRY_NOTICE_NOTES, EXPIRY_NOTICE_MAX_AGE_MS,
  swapShiftHasStarted, swapShiftStartMs, swapShiftStartedInEveryZone, swapExpiryNote, deferredExpiryNoticeDue,
} from './swap-cover'
import * as sharedHours from './staff-push-hours'

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

describe('openPoolPayload', () => {
  const args = { swapId: 'swap-1', block: BLOCK, requesterName: 'Coach R', studioName: 'Studio North' }
  it('says WHO, WHERE and WHEN: a coach who works at two studios must be able to tell which', () => {
    expect(openPoolPayload(args)).toEqual({
      title: 'A shift needs cover',
      body: 'Coach R needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00. Tap to take it.',
      category: 'swap',
      emailSubject: 'A shift needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00',
      data: { type: 'swap_open_pool', swap_id: 'swap-1', block_date: '2026-09-24' },
    })
  })
  it.each([[null], [''], ['   '], [undefined]])('an unreadable studio name (%j) is left out, never printed', (studioName) => {
    const p = openPoolPayload({ ...args, studioName })
    expect(p.body).toBe('Coach R needs cover: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
    expect(p.emailSubject).toBe('A shift needs cover: Thu 24 Sep, 06:00 to 07:00')
  })
  it('keeps the studio SHORT: a long name is cut so the time range still fits on a lock screen', () => {
    const p = openPoolPayload({ ...args, studioName: 'The Very Long Official Registered Name Of A Studio Limited' })
    expect(p.body).toBe('Coach R needs cover at The Very Long Official Registe…: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
  })
  it('says "A coach" when the requester has no name', () => {
    expect(openPoolPayload({ ...args, requesterName: null }).body).toBe('A coach needs cover at Studio North: Thu 24 Sep, 06:00 to 07:00. Tap to take it.')
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

// ─────────────────────────────────────────────────────────────────────────
// QUIET HOURS — a staff push that is not a direct response to the recipient's
// own action is only SENT while the studio's wall clock is 07:00 to 22:00.
// ─────────────────────────────────────────────────────────────────────────
// The band itself (exact boundaries, both DST weekends, other zones, invalid
// and empty zones) is tabled ONCE, in staff-push-hours.test.js. Here: this
// module uses THAT rule, not a copy of it.
describe('inStaffPushHours', () => {
  it('is the shared staff-push-hours rule, re-exported under the names this module always had', () => {
    expect(inStaffPushHours).toBe(sharedHours.inStaffPushHours)
    expect(STAFF_PUSH_HOURS).toBe(sharedHours.STAFF_PUSH_HOURS)
    expect(STAFF_PUSH_HOURS).toEqual({ start: '07:00', end: '22:00' })
  })
})

const H = 3600 * 1000
// 2099-01-01 is winter: 09:00 Dublin IS 09:00 UTC. A 09:00 start keeps every
// stage boundary below (T-48h 09:00, T-12h 21:00, the start itself) INSIDE
// the 07:00-22:00 band, so these rows test the stage logic alone.
const START = Date.UTC(2099, 0, 1, 9, 0)
const WINTER_BLOCK = { id: 'blk-1', block_date: '2099-01-01', start_time: '09:00:00', end_time: '10:00:00' }
const openSwap = (over = {}) => ({
  id: 's1', status: 'pending', location_id: 'loc-1', requester_id: 'req', target_id: null,
  requester_shift_id: 'a1', created_at: new Date(START - 200 * H).toISOString(),
  requester: { full_name: 'Coach R' },
  requester_shift: { id: 'a1', shift_blocks: WINTER_BLOCK },
  ...over,
})
const swapOn = (block_date, start_time, over = {}) => openSwap({
  created_at: '2020-01-01T00:00:00.000Z',
  requester_shift: { id: 'a1', shift_blocks: { id: 'b', block_date, start_time, end_time: '23:59:00' } },
  ...over,
})

describe('coverSweepAction', () => {
  it.each([
    { name: 'more than 48h out: nothing', swap: openSwap(), now: START - 49 * H, expected: { action: 'none' } },
    { name: 'exactly T-48h: first nudge', swap: openSwap(), now: START - 48 * H, expected: { action: 'nudge', stage: 't48' } },
    { name: 'T-36h (a missed tick fires late, not never)', swap: openSwap(), now: START - 36 * H, expected: { action: 'nudge', stage: 't48' } },
    { name: 'exactly T-12h: second nudge', swap: openSwap(), now: START - 12 * H, expected: { action: 'nudge', stage: 't12' } },
    { name: 'T-1h: still the t12 stage', swap: openSwap(), now: START - 1 * H, expected: { action: 'nudge', stage: 't12' } },
    {
      name: 'posted at T-30h: no t48 nudge, managers heard swap_open minutes ago',
      swap: openSwap({ created_at: new Date(START - 30 * H).toISOString() }), now: START - 20 * H, expected: { action: 'none' },
    },
    {
      name: 'posted at T-30h: the t12 nudge still fires',
      swap: openSwap({ created_at: new Date(START - 30 * H).toISOString() }), now: START - 2 * H, expected: { action: 'nudge', stage: 't12' },
    },
    {
      name: 'posted at T-5h: no nudge at all',
      swap: openSwap({ created_at: new Date(START - 5 * H).toISOString() }), now: START - 1 * H, expected: { action: 'none' },
    },
    { name: 'at the start: expire', swap: openSwap(), now: START, expected: { action: 'expire', reason: 'started', notify: true } },
    { name: 'a day after the start: expire', swap: openSwap(), now: START + 24 * H, expected: { action: 'expire', reason: 'started', notify: true } },
    { name: 'a CLAIMED swap is nudged too', swap: openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), now: START - 12 * H, expected: { action: 'nudge', stage: 't12' } },
    { name: 'a claimed swap expires too', swap: openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), now: START, expected: { action: 'expire', reason: 'started', notify: true } },
    {
      name: 'the shift was deleted (mig 603 SET NULL): expire, whatever the shift clock says',
      swap: openSwap({ requester_shift_id: null, requester_shift: null }), now: START - 500 * H, expected: { action: 'expire', reason: 'shift_removed', notify: true },
    },
    {
      name: 'an embed that did not come back is NOT a deleted shift: do nothing',
      swap: openSwap({ requester_shift: null }), now: START + H, expected: { action: 'none' },
    },
    {
      name: 'an unreadable start time: do nothing rather than guess',
      swap: openSwap({ requester_shift: { id: 'a1', shift_blocks: { ...WINTER_BLOCK, start_time: 'soon' } } }), now: START + H, expected: { action: 'none' },
    },
    { name: 'a decided swap is never touched', swap: openSwap({ status: 'approved' }), now: START + H, expected: { action: 'none' } },
    { name: 'null swap', swap: null, now: START, expected: { action: 'none' } },
  ])('$name', ({ swap, now, expected }) => {
    expect(coverSweepAction(swap, now)).toEqual(expected)
  })

  // The "managers heard moments ago" suppression must count the CLAIM too: a
  // claim sends managers swap_awaiting, and the nudge key carries the status,
  // so without this a swap posted at T-100h and claimed at T-30h re-pushed
  // them (awaiting_approval:t48) on the very next tick.
  describe('a swap claimed inside a stage', () => {
    const claimedAt = (hoursBefore, over = {}) => openSwap({
      status: 'awaiting_approval', target_id: 'tkr',
      created_at: new Date(START - 100 * H).toISOString(),
      updated_at: new Date(START - hoursBefore * H).toISOString(),
      ...over,
    })
    it.each([
      { name: 'claimed at T-30h: no t48 nudge a tick later', swap: claimedAt(30), now: START - 30 * H + 15 * 60 * 1000, expected: { action: 'none' } },
      { name: '... nor for the rest of the t48 stage', swap: claimedAt(30), now: START - 13 * H, expected: { action: 'none' } },
      { name: '... the t12 nudge still fires', swap: claimedAt(30), now: START - 12 * H, expected: { action: 'nudge', stage: 't12' } },
      { name: 'claimed at T-5h: no nudge at all', swap: claimedAt(5), now: START - 1 * H, expected: { action: 'none' } },
      { name: 'claimed at T-60h (before any stage): t48 fires as normal', swap: claimedAt(60), now: START - 48 * H, expected: { action: 'nudge', stage: 't48' } },
      { name: 'a PENDING swap ignores updated_at: only the posting counts', swap: openSwap({ updated_at: new Date(START - 30 * H).toISOString() }), now: START - 24 * H, expected: { action: 'nudge', stage: 't48' } },
      { name: 'an unreadable updated_at falls back to created_at', swap: claimedAt(30, { updated_at: null }), now: START - 24 * H, expected: { action: 'nudge', stage: 't48' } },
    ])('$name', ({ swap, now, expected }) => {
      expect(coverSweepAction(swap, now)).toEqual(expected)
    })
  })

  // Studio wall-clock, not UTC: on 2026-07-02 (IST, UTC+1) 09:00 is 08:00Z.
  it('reads the block start as Europe/Dublin wall-clock by default', () => {
    const summer = swapOn('2026-07-02', '09:00:00')
    expect(coverSweepAction(summer, Date.UTC(2026, 6, 2, 7, 59))).toEqual({ action: 'nudge', stage: 't12' })
    expect(coverSweepAction(summer, Date.UTC(2026, 6, 2, 8, 0))).toEqual({ action: 'expire', reason: 'started', notify: true })
  })

  it('reads the block start in the STUDIO\'s zone when one is given', () => {
    const ny = swapOn('2099-01-01', '09:00:00') // 09:00 EST is 14:00Z
    expect(coverSweepAction(ny, Date.UTC(2099, 0, 1, 13, 59), { tz: 'America/New_York' })).toEqual({ action: 'nudge', stage: 't12' })
    expect(coverSweepAction(ny, Date.UTC(2099, 0, 1, 14, 0), { tz: 'America/New_York' })).toEqual({ action: 'expire', reason: 'started', notify: true })
  })

  // QUIET HOURS. A NUDGE that is due outside 07:00-22:00 studio time waits
  // for a later tick. An EXPIRY never waits: it comes back with notify:false.
  describe('quiet hours', () => {
    const QUIET = { action: 'none', reason: 'quiet_hours' }
    it.each([
      // A 14:00 shift: T-12h comes due at 02:00.
      { name: 'a T-12h nudge that comes due at 02:00 is NOT sent at 02:00', swap: swapOn('2099-01-02', '14:00:00'), now: Date.UTC(2099, 0, 2, 2, 0), expected: QUIET },
      { name: '... nor at 06:59', swap: swapOn('2099-01-02', '14:00:00'), now: Date.UTC(2099, 0, 2, 6, 59), expected: QUIET },
      { name: '... it is sent at 07:00, the shift has not started', swap: swapOn('2099-01-02', '14:00:00'), now: Date.UTC(2099, 0, 2, 7, 0), expected: { action: 'nudge', stage: 't12' } },
      // A 22:00 shift two days out: T-48h comes due at 22:00 exactly, which is outside the band.
      { name: 'a T-48h nudge that comes due at 22:00 waits', swap: swapOn('2099-01-03', '22:00:00'), now: Date.UTC(2099, 0, 1, 22, 0), expected: QUIET },
      { name: '... and is sent at 07:00 next morning (still the t48 stage)', swap: swapOn('2099-01-03', '22:00:00'), now: Date.UTC(2099, 0, 2, 7, 0), expected: { action: 'nudge', stage: 't48' } },
      { name: '21:59 is inside the band', swap: swapOn('2099-01-03', '21:59:00'), now: Date.UTC(2099, 0, 1, 21, 59), expected: { action: 'nudge', stage: 't48' } },
      // The gym's real case: the 06:00 class.
      // STATE never waits for quiet hours; only the NOTICE does. A started
      // shift's swap closes on the very next tick, at any hour: nothing else
      // refuses a claim or an approval on a shift already being worked.
      { name: 'a 06:00 shift that has started IS expired at 06:00, without a notice', swap: swapOn('2099-01-02', '06:00:00'), now: Date.UTC(2099, 0, 2, 6, 0), expected: { action: 'expire', reason: 'started', notify: false } },
      { name: '... and at 06:45', swap: swapOn('2099-01-02', '06:00:00'), now: Date.UTC(2099, 0, 2, 6, 45), expected: { action: 'expire', reason: 'started', notify: false } },
      { name: '... from 07:00 the notice may go with it', swap: swapOn('2099-01-02', '06:00:00'), now: Date.UTC(2099, 0, 2, 7, 0), expected: { action: 'expire', reason: 'started', notify: true } },
      { name: 'a 22:30 shift is closed at 22:30, not in the morning', swap: swapOn('2099-01-01', '22:30:00'), now: Date.UTC(2099, 0, 1, 22, 30), expected: { action: 'expire', reason: 'started', notify: false } },
      { name: '... 22:31 too', swap: swapOn('2099-01-01', '22:30:00'), now: Date.UTC(2099, 0, 1, 22, 31), expected: { action: 'expire', reason: 'started', notify: false } },
      { name: 'a removed shift closes at once, at any hour (it sends nothing anyway)', swap: openSwap({ requester_shift_id: null, requester_shift: null }), now: Date.UTC(2099, 0, 1, 3, 0), expected: { action: 'expire', reason: 'shift_removed', notify: false } },
      { name: 'nothing due in quiet hours is plain "none", not a deferral', swap: swapOn('2099-02-01', '14:00:00'), now: Date.UTC(2099, 0, 2, 2, 0), expected: { action: 'none' } },
      // SPRING FORWARD (Sun 2026-03-29). A 10:00 IST shift starts 09:00Z; T-12h fell at 21:00Z Saturday = 21:00 GMT, so use a swap posted long ago and look at Sunday morning.
      { name: 'spring forward: 06:59 IST (05:59Z) is quiet', swap: swapOn('2026-03-29', '10:00:00'), now: Date.UTC(2026, 2, 29, 5, 59), expected: QUIET },
      { name: 'spring forward: 07:00 IST (06:00Z) sends', swap: swapOn('2026-03-29', '10:00:00'), now: Date.UTC(2026, 2, 29, 6, 0), expected: { action: 'nudge', stage: 't12' } },
      { name: 'spring forward: the shift starts at 09:00Z, not 10:00Z', swap: swapOn('2026-03-29', '10:00:00'), now: Date.UTC(2026, 2, 29, 9, 0), expected: { action: 'expire', reason: 'started', notify: true } },
      // FALL BACK (Sun 2026-10-25). A 10:00 GMT shift starts 10:00Z.
      { name: 'fall back: 06:00Z is 06:00 GMT, quiet (on Saturday the same instant was 07:00 IST)', swap: swapOn('2026-10-25', '10:00:00'), now: Date.UTC(2026, 9, 25, 6, 0), expected: QUIET },
      { name: 'fall back: 07:00 GMT (07:00Z) sends', swap: swapOn('2026-10-25', '10:00:00'), now: Date.UTC(2026, 9, 25, 7, 0), expected: { action: 'nudge', stage: 't12' } },
      { name: 'fall back: 09:59Z has not started', swap: swapOn('2026-10-25', '10:00:00'), now: Date.UTC(2026, 9, 25, 9, 59), expected: { action: 'nudge', stage: 't12' } },
      { name: 'fall back: 10:00Z has', swap: swapOn('2026-10-25', '10:00:00'), now: Date.UTC(2026, 9, 25, 10, 0), expected: { action: 'expire', reason: 'started', notify: true } },
      { name: 'fall back, Saturday night: 21:00Z is 22:00 IST, quiet', swap: swapOn('2026-10-25', '10:00:00'), now: Date.UTC(2026, 9, 24, 21, 0), expected: QUIET },
    ])('$name', ({ swap, now, expected }) => {
      expect(coverSweepAction(swap, now)).toEqual(expected)
    })

    it('the band is judged in the studio\'s zone', () => {
      const ny = swapOn('2099-01-02', '14:00:00') // 14:00 EST = 19:00Z
      expect(coverSweepAction(ny, Date.UTC(2099, 0, 2, 11, 59), { tz: 'America/New_York' })).toEqual(QUIET) // 06:59 EST
      expect(coverSweepAction(ny, Date.UTC(2099, 0, 2, 12, 0), { tz: 'America/New_York' })).toEqual({ action: 'nudge', stage: 't12' })
    })

    it('an invalid studio zone behaves as Europe/Dublin', () => {
      const s = swapOn('2099-01-02', '14:00:00')
      expect(coverSweepAction(s, Date.UTC(2099, 0, 2, 6, 59), { tz: 'Not/AZone' })).toEqual(QUIET)
      expect(coverSweepAction(s, Date.UTC(2099, 0, 2, 7, 0), { tz: 'Not/AZone' })).toEqual({ action: 'nudge', stage: 't12' })
    })
  })
})

describe('coverNudgePayload', () => {
  it('an unclaimed swap: "Still uncovered", routed like swap_open (managers -> approvals)', () => {
    expect(coverNudgePayload(openSwap(), 't48')).toEqual({
      key: 'swap_cover_nudge:s1:pending:t48',
      payload: {
        title: 'Shift still uncovered',
        body: 'Still uncovered: Thu 1 Jan, 09:00 to 10:00. Coach R posted it and nobody has taken it yet. Tap to review.',
        category: 'swap',
        emailSubject: 'Still uncovered: Thu 1 Jan, 09:00 to 10:00',
        data: { type: 'swap_open', swap_id: 's1' },
      },
    })
  })

  it('a claimed swap: asks for the approval, routed like swap_awaiting', () => {
    const out = coverNudgePayload(openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), 't12')
    expect(out.key).toBe('swap_cover_nudge:s1:awaiting_approval:t12')
    expect(out.payload.title).toBe('Swap still waiting for approval')
    expect(out.payload.body).toBe("Thu 1 Jan, 09:00 to 10:00: Coach R's shift has been taken by a colleague and still needs your approval. Tap to approve.")
    expect(out.payload.data).toEqual({ type: 'swap_awaiting', swap_id: 's1' })
  })

  it('never prints "null" for a requester with no name', () => {
    expect(coverNudgePayload(openSwap({ requester: { full_name: null } }), 't48').payload.body).toContain('A coach posted it')
  })
})

describe('swapExpiryNotices', () => {
  it('an unclaimed swap: the requester is told once, and it lands on that day of the schedule', () => {
    expect(swapExpiryNotices(openSwap(), 'started')).toEqual([{
      key: 'swap_expired:s1',
      to: ['req'],
      payload: {
        title: 'Swap request expired',
        body: 'Nobody took your shift on Thu 1 Jan, 09:00 to 10:00 before it started, so the swap request has closed and the shift stayed with you.',
        category: 'swap',
        emailSubject: 'Your swap request expired',
        data: { type: 'swap_decision', swap_id: 's1', status: 'cancelled', block_date: '2099-01-01' },
      },
    }])
  })

  it('a claimed swap: the requester AND the taker are told, each in their own words', () => {
    const out = swapExpiryNotices(openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), 'started')
    expect(out.map((n) => [n.key, n.to])).toEqual([['swap_expired:s1', ['req']], ['swap_expired_taker:s1', ['tkr']]])
    expect(out[0].payload.body).toBe('Your swap for Thu 1 Jan, 09:00 to 10:00 was not approved before the shift started, so it has closed and the shift stayed with you.')
    expect(out[1].payload.body).toBe('The swap you took for Thu 1 Jan, 09:00 to 10:00 was not approved before the shift started, so it has closed. The shift stayed with Coach R.')
  })

  it('a removed shift tells nobody: the roster change already did, and there is no date left to describe', () => {
    expect(swapExpiryNotices(openSwap({ requester_shift_id: null, requester_shift: null }), 'shift_removed')).toEqual([])
  })

  it('a deferred notice whose shift has since been deleted tells nobody: there is nothing left to describe', () => {
    const row = openSwap({ status: 'cancelled', review_note: SWAP_EXPIRY_NOTES.started, requester_shift: null })
    expect(swapExpiryNotices(row, 'started')).toEqual([])
  })

  it('has a distinct system review_note for every reason', () => {
    const notes = Object.values(SWAP_EXPIRY_NOTES)
    expect(Object.keys(SWAP_EXPIRY_NOTES).sort()).toEqual(['shift_removed', 'started', 'started_claimed'])
    expect(new Set(notes).size).toBe(3)
    for (const n of notes) expect(n).toMatch(/^Closed automatically/)
    // The notes that carry a notice: a removed shift tells nobody.
    expect(SWAP_EXPIRY_NOTICE_NOTES).toEqual([SWAP_EXPIRY_NOTES.started, SWAP_EXPIRY_NOTES.started_claimed])
  })

  it.each([
    ['pending', 'started', SWAP_EXPIRY_NOTES.started],
    ['awaiting_approval', 'started', SWAP_EXPIRY_NOTES.started_claimed],
    ['pending', 'shift_removed', SWAP_EXPIRY_NOTES.shift_removed],
    ['awaiting_approval', 'shift_removed', SWAP_EXPIRY_NOTES.shift_removed],
  ])('swapExpiryNote(%s, %s)', (status, reason, expected) => {
    expect(swapExpiryNote(openSwap({ status }), reason)).toBe(expected)
  })

  // The DEFERRED notice is built from the row AFTER it was cancelled, so
  // "this swap had been claimed" has to survive in the note.
  it('a CANCELLED row with the started_claimed note still tells the taker', () => {
    const row = openSwap({ status: 'cancelled', target_id: 'tkr', review_note: SWAP_EXPIRY_NOTES.started_claimed })
    const out = swapExpiryNotices(row, 'started')
    expect(out.map((n) => [n.key, n.to])).toEqual([['swap_expired:s1', ['req']], ['swap_expired_taker:s1', ['tkr']]])
    expect(out[0].payload.body).toContain('was not approved before the shift started')
  })

  it('a CANCELLED row with the plain started note tells the requester only, in the unclaimed words', () => {
    const row = openSwap({ status: 'cancelled', target_id: null, review_note: SWAP_EXPIRY_NOTES.started })
    const out = swapExpiryNotices(row, 'started')
    expect(out.map((n) => n.key)).toEqual(['swap_expired:s1'])
    expect(out[0].payload.body).toContain('Nobody took your shift')
  })

  it('the same keys whether the notice is sent at once or deferred (that is what makes it exactly-once)', () => {
    const live = swapExpiryNotices(openSwap({ status: 'awaiting_approval', target_id: 'tkr' }), 'started')
    const later = swapExpiryNotices(openSwap({ status: 'cancelled', target_id: 'tkr', review_note: SWAP_EXPIRY_NOTES.started_claimed }), 'started')
    expect(later).toEqual(live)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// "Has this shift started?" — ONE predicate, shared by the sweep (which closes
// the swap) and PUT /api/schedule/swaps/:id (which refuses a claim, accept or
// approval), so the two can never disagree.
// ─────────────────────────────────────────────────────────────────────────
describe('swapShiftHasStarted', () => {
  const shift = (block_date, start_time, start_time_override = null) => ({ block_date, start_time, start_time_override })
  it.each([
    // Winter: Dublin is UTC.
    ['one minute before', shift('2099-01-01', '09:00:00'), '2099-01-01T08:59:00Z', undefined, false],
    ['on the minute', shift('2099-01-01', '09:00:00'), '2099-01-01T09:00:00Z', undefined, true],
    ['the day after', shift('2099-01-01', '09:00:00'), '2099-01-02T03:00:00Z', undefined, true],
    // Summer (IST): 09:00 is 08:00Z.
    ['IST: 07:59Z has not', shift('2026-07-02', '09:00:00'), '2026-07-02T07:59:00Z', undefined, false],
    ['IST: 08:00Z has', shift('2026-07-02', '09:00:00'), '2026-07-02T08:00:00Z', undefined, true],
    // The EFFECTIVE start: the assignment's own override wins over the block.
    ['an earlier override starts it earlier', shift('2099-01-01', '09:00:00', '08:30:00'), '2099-01-01T08:30:00Z', undefined, true],
    ['a later override starts it later', shift('2099-01-01', '09:00:00', '09:30:00'), '2099-01-01T09:15:00Z', undefined, false],
    // SPRING FORWARD, Sun 2026-03-29 (01:00 GMT -> 02:00 IST).
    ['spring: Sat 06:00 GMT is 06:00Z', shift('2026-03-28', '06:00:00'), '2026-03-28T05:59:00Z', undefined, false],
    ['spring: Sat 06:00 GMT started at 06:00Z', shift('2026-03-28', '06:00:00'), '2026-03-28T06:00:00Z', undefined, true],
    ['spring: Sun 06:00 IST is 05:00Z, not 06:00Z', shift('2026-03-29', '06:00:00'), '2026-03-29T04:59:00Z', undefined, false],
    ['spring: Sun 06:00 IST started at 05:00Z', shift('2026-03-29', '06:00:00'), '2026-03-29T05:00:00Z', undefined, true],
    ['spring: a 00:30 shift, before the jump, is 00:30Z', shift('2026-03-29', '00:30:00'), '2026-03-29T00:30:00Z', undefined, true],
    // FALL BACK, Sun 2026-10-25 (02:00 IST -> 01:00 GMT).
    ['autumn: Sat 06:00 IST started at 05:00Z', shift('2026-10-24', '06:00:00'), '2026-10-24T05:00:00Z', undefined, true],
    ['autumn: Sun 06:00 GMT has NOT started at 05:00Z', shift('2026-10-25', '06:00:00'), '2026-10-25T05:00:00Z', undefined, false],
    ['autumn: Sun 06:00 GMT started at 06:00Z', shift('2026-10-25', '06:00:00'), '2026-10-25T06:00:00Z', undefined, true],
    ['autumn: a 22:30 shift on the 25-hour day is 22:30Z', shift('2026-10-25', '22:30:00'), '2026-10-25T22:29:00Z', undefined, false],
    // The studio's zone.
    ['New York 09:00 is 14:00Z', shift('2099-01-01', '09:00:00'), '2099-01-01T13:59:00Z', 'America/New_York', false],
    ['New York 09:00 started at 14:00Z', shift('2099-01-01', '09:00:00'), '2099-01-01T14:00:00Z', 'America/New_York', true],
    ['an invalid zone is Dublin', shift('2099-01-01', '09:00:00'), '2099-01-01T09:00:00Z', 'Not/AZone', true],
    // Unreadable -> NOT started: never close or refuse on a guess.
    ['an unreadable time', shift('2099-01-01', 'soon'), '2099-06-01T00:00:00Z', undefined, false],
    ['an impossible date', shift('2026-02-31', '09:00:00'), '2099-06-01T00:00:00Z', undefined, false],
    ['no shift', null, '2099-06-01T00:00:00Z', undefined, false],
  ])('%s', (_name, sh, iso, tz, expected) => {
    expect(swapShiftHasStarted(sh, Date.parse(iso), tz)).toBe(expected)
  })

  it('swapShiftStartMs is the instant it is judged on, or null', () => {
    expect(swapShiftStartMs({ block_date: '2026-07-02', start_time: '09:00:00' })).toBe(Date.UTC(2026, 6, 2, 8, 0))
    expect(swapShiftStartMs({ block_date: '2026-07-02', start_time: '09:00:00', start_time_override: '08:45:00' })).toBe(Date.UTC(2026, 6, 2, 7, 45))
    expect(swapShiftStartMs({ block_date: '2026-07-02', start_time: null })).toBe(null)
  })

  it('the sweep uses the same effective start: an earlier override closes the swap earlier', () => {
    const swap = openSwap({ requester_shift: { id: 'a1', start_time_override: '08:30:00', shift_blocks: WINTER_BLOCK } })
    expect(coverSweepAction(swap, Date.UTC(2099, 0, 1, 8, 29))).toEqual({ action: 'nudge', stage: 't12' })
    expect(coverSweepAction(swap, Date.UTC(2099, 0, 1, 8, 30))).toEqual({ action: 'expire', reason: 'started', notify: true })
  })
})

// The route's read-avoidance: far from the start, the answer is the same in
// every timezone on earth (UTC-12 to UTC+14), so locations.timezone need not
// be read. null = "it depends on the zone: read it".
describe('swapShiftStartedInEveryZone', () => {
  const sh = { block_date: '2099-01-10', start_time: '09:00:00', start_time_override: null }
  const utc = Date.UTC(2099, 0, 10, 9, 0)
  it.each([
    ['days before', utc - 72 * H, false],
    ['15h before the UTC reading: no zone has started', utc - 15 * H, false],
    ['14h59 before: a UTC+14 studio might have', utc - 15 * H + 60 * 1000, null],
    ['at the UTC reading', utc, null],
    ['12h59 after: a UTC-12 studio might not have', utc + 13 * H - 60 * 1000, null],
    ['13h after: every zone has started', utc + 13 * H, true],
    ['years after', utc + 9000 * H, true],
  ])('%s', (_n, now, expected) => {
    expect(swapShiftStartedInEveryZone(sh, now)).toBe(expected)
  })
  it('never contradicts the real predicate, in the widest real zones', () => {
    for (const tz of ['Pacific/Kiritimati', 'Etc/UTC', 'Europe/Dublin', 'America/New_York', 'Pacific/Pago_Pago']) {
      for (let h = -40; h <= 40; h++) {
        const now = utc + h * H
        const quick = swapShiftStartedInEveryZone(sh, now)
        if (quick !== null) expect([tz, h, quick]).toEqual([tz, h, swapShiftHasStarted(sh, now, tz)])
      }
    }
  })
  it('unreadable: false, like the predicate', () => {
    expect(swapShiftStartedInEveryZone({ block_date: '2099-01-10', start_time: null }, utc)).toBe(false)
    expect(swapShiftStartedInEveryZone(null, utc)).toBe(false)
  })
})

describe('deferredExpiryNoticeDue', () => {
  const NOW = Date.UTC(2099, 0, 2, 7, 0) // 07:00 Dublin, winter
  const closed = (over = {}) => openSwap({
    status: 'cancelled', reviewed_by: null, review_note: SWAP_EXPIRY_NOTES.started,
    updated_at: new Date(NOW - 8 * H).toISOString(), ...over,
  })
  it('the window is 24 hours', () => { expect(EXPIRY_NOTICE_MAX_AGE_MS).toBe(24 * H) })

  it.each([
    ['closed by the sweep overnight, studio now in band', closed(), NOW, undefined, true],
    ['the claimed note counts too', closed({ review_note: SWAP_EXPIRY_NOTES.started_claimed, target_id: 'tkr' }), NOW, undefined, true],
    ['still quiet hours: not yet', closed(), NOW - 60 * 1000, undefined, false],
    ['quiet in the STUDIO\'s zone: not yet', closed(), NOW, 'America/New_York', false],
    ['a removed shift never announces', closed({ review_note: SWAP_EXPIRY_NOTES.shift_removed }), NOW, undefined, false],
    ['a COACH\'s own cancel (no system note) never announces', closed({ review_note: null }), NOW, undefined, false],
    ['a note that merely resembles a system note does not match', closed({ review_note: `${SWAP_EXPIRY_NOTES.started} ` }), NOW, undefined, false],
    ['a manager-reviewed row never announces', closed({ reviewed_by: 'mgr' }), NOW, undefined, false],
    ['not cancelled', closed({ status: 'pending' }), NOW, undefined, false],
    ['exactly 24h old: still announced', closed({ updated_at: new Date(NOW - 24 * H).toISOString() }), NOW, undefined, true],
    ['older than 24h: never re-announced', closed({ updated_at: new Date(NOW - 24 * H - 1).toISOString() }), NOW, undefined, false],
    ['an unreadable updated_at: no', closed({ updated_at: null }), NOW, undefined, false],
    ['null row', null, NOW, undefined, false],
  ])('%s', (_name, row, now, tz, expected) => {
    expect(deferredExpiryNoticeDue(row, now, { tz })).toBe(expected)
  })
})

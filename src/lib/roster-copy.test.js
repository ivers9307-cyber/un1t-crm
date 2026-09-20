// COPYMODES.1 — pure plan builders for the two copy modes, the template-mode
// month mapping, and the paged source read.
//
// Date handling must be host-TZ independent. Run under both:
//   for tz in Europe/Dublin America/Los_Angeles; do
//     TZ=$tz npx vitest run src/lib/roster-copy.test.js
//   done
import { describe, it, expect } from 'vitest'
import {
  buildCopyPlan, mapNthWeekdayOfMonth, weekdayCodeOf, fetchSourceBlocks, copyResultToast,
  approvedLeaveLookup, liveCoachIds, fetchApprovedLeave,
} from './roster-copy'
import { redateShiftDate } from '../app/api/schedule/shifts/copy-week/route.js'

const MON_FRI = ['mon', 'tue', 'wed', 'thu', 'fri']
const tpl = (over = {}) => ({
  id: 't1', active: true, days_of_week: MON_FRI,
  start_time: '09:00:00', end_time: '10:00:00', min_coaches: 2, max_coaches: 6, ...over,
})

// Mon 29 Jun 2026 (BST). A week copy moves it +7 days to Mon 6 Jul.
function block(over = {}) {
  return {
    id: 'b1', template_id: 't1', block_date: '2026-06-29',
    start_time: '09:00:00', end_time: '10:00:00', min_coaches: 2, max_coaches: 6,
    shift_templates: tpl(),
    shift_assignments: [],
    ...over,
  }
}
const weekMap = (d) => redateShiftDate(d, 7)

describe('weekdayCodeOf', () => {
  it('reads the calendar weekday of a bare date whatever the host TZ', () => {
    expect(weekdayCodeOf('2026-06-29')).toBe('mon') // BST
    expect(weekdayCodeOf('2026-07-05')).toBe('sun')
    expect(weekdayCodeOf('2026-03-29')).toBe('sun') // spring DST day
    expect(weekdayCodeOf('2026-10-25')).toBe('sun') // autumn DST day
    expect(weekdayCodeOf('2026-12-14')).toBe('mon') // winter
  })
})

// COPYLEAVE.1 — the copy honours APPROVED leave, and only approved leave.
describe('approvedLeaveLookup', () => {
  const onLeave = approvedLeaveLookup([
    { profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-08' },
    { profile_id: 'p2', status: 'pending', start_date: '2026-07-06', end_date: '2026-07-08' },
    { profile_id: 'p3', status: 'rejected', start_date: '2026-07-06', end_date: '2026-07-08' },
  ])

  it('covers the first and the last day: end_date is inclusive (mig 011)', () => {
    expect(onLeave('p1', '2026-07-06')).toBe(true)
    expect(onLeave('p1', '2026-07-07')).toBe(true)
    expect(onLeave('p1', '2026-07-08')).toBe(true)
  })

  it('does not cover the day before or the day after', () => {
    expect(onLeave('p1', '2026-07-05')).toBe(false)
    expect(onLeave('p1', '2026-07-09')).toBe(false)
  })

  it('PENDING and REJECTED leave never count, even if a caller hands them in', () => {
    expect(onLeave('p2', '2026-07-07')).toBe(false)
    expect(onLeave('p3', '2026-07-07')).toBe(false)
  })

  it('an unknown coach, and an empty or missing list, are never on leave', () => {
    expect(onLeave('nobody', '2026-07-07')).toBe(false)
    expect(approvedLeaveLookup([])('p1', '2026-07-07')).toBe(false)
    expect(approvedLeaveLookup(null)('p1', '2026-07-07')).toBe(false)
  })
})

describe('liveCoachIds', () => {
  it('returns each live coach once, and never a cancelled one', () => {
    const ids = liveCoachIds([
      block({ shift_assignments: [
        { profile_id: 'p1', status: 'scheduled' },
        { profile_id: 'p2', status: 'cancelled' },
      ] }),
      block({ id: 'b2', shift_assignments: [
        { profile_id: 'p1', status: 'swapped' },
        { profile_id: 'p3', status: 'scheduled' },
      ] }),
    ])
    expect(ids.sort()).toEqual(['p1', 'p3'])
  })

  it('is empty for no blocks', () => {
    expect(liveCoachIds([])).toEqual([])
    expect(liveCoachIds(null)).toEqual([])
  })
})

describe('buildCopyPlan — exact', () => {
  it('carries each live coach with the times they actually had, partial_reason and notes', () => {
    const plan = buildCopyPlan([
      block({
        // Block edited to 09:30 on the day (template says 09:00).
        start_time: '09:30:00',
        shift_assignments: [
          { profile_id: 'p1', status: 'scheduled', notes: 'keys', partial_reason: null, start_time_override: null, end_time_override: null },
          { profile_id: 'p2', status: 'swapped', notes: null, partial_reason: 'dentist', start_time_override: null, end_time_override: '09:45:00' },
          { profile_id: 'p3', status: 'cancelled', notes: null, partial_reason: null, start_time_override: null, end_time_override: null },
        ],
      }),
    ], { mode: 'exact', mapDate: weekMap })

    expect(plan.sourceAssignments).toBe(2)
    expect(plan.skipped).toBe(0)
    expect(plan.rows).toEqual([
      { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-07-06', startTime: '09:30:00', endTime: '10:00:00', partialReason: null, notes: 'keys', status: 'scheduled' },
      // swapped is live (the taker's shift) but is inserted as scheduled
      { profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-07-06', startTime: '09:30:00', endTime: '09:45:00', partialReason: 'dentist', notes: null, status: 'scheduled' },
    ])
  })

  it('ensures every source block on the target, empty ones included, seeded from the SOURCE block', () => {
    const plan = buildCopyPlan([
      block({ id: 'b1', start_time: '06:30:00', end_time: '08:00:00', min_coaches: 1, max_coaches: 3 }),
      block({ id: 'b2', block_date: '2026-07-05', shift_templates: tpl({ days_of_week: ['sun'] }) }),
    ], { mode: 'exact', mapDate: weekMap })

    expect(plan.sourceAssignments).toBe(0)
    expect(plan.rows).toEqual([])
    expect(plan.blocks).toEqual([
      { shiftTemplateId: 't1', shiftDate: '2026-07-06', startTime: '06:30:00', endTime: '08:00:00', minCoaches: 1, maxCoaches: 3 },
      // Sunday stays in range under BST (the old toISOString slip dropped it)
      { shiftTemplateId: 't1', shiftDate: '2026-07-12', startTime: '09:00:00', endTime: '10:00:00', minCoaches: 2, maxCoaches: 6 },
    ])
  })

  // Review fix — day-of-month mapping moves the weekday, and the source month
  // is full of cron-made EMPTY blocks for every slot. Carrying those blindly
  // put a Saturday-only template's empty blocks onto Tuesdays.
  it('does not carry an EMPTY block onto a weekday its template does not run (Sat-only, Aug -> Sep 2026)', () => {
    const satOnly = tpl({ days_of_week: ['sat'] })
    const augSaturdays = ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']
    const sourceBlocks = augSaturdays.map((d, i) => block({ id: `sat${i}`, block_date: d, shift_templates: satOnly }))
    // Day-of-month into September: 1, 8, 15, 22, 29 Sep 2026 are all Tuesdays.
    const plan = buildCopyPlan(sourceBlocks, { mode: 'exact', mapDate: (d) => `2026-09-${d.slice(8)}` })
    expect(augSaturdays.map((d) => weekdayCodeOf(`2026-09-${d.slice(8)}`))).toEqual(['tue', 'tue', 'tue', 'tue', 'tue'])
    expect(plan.blocks).toEqual([])
    expect(plan.rows).toEqual([])
  })

  it('still carries an empty block that lands on a weekday its template runs', () => {
    const plan = buildCopyPlan([
      block({ block_date: '2026-08-05', shift_templates: tpl({ days_of_week: ['sat'] }) }), // Wed 5 Aug -> Sat 5 Sep
    ], { mode: 'exact', mapDate: () => '2026-09-05' })
    expect(plan.blocks.map((b) => b.shiftDate)).toEqual(['2026-09-05'])
  })

  it('carries a STAFFED block wherever it lands, even off its template days (carbon copy)', () => {
    const plan = buildCopyPlan([
      block({ block_date: '2026-08-01', shift_templates: tpl({ days_of_week: ['sat'] }), shift_assignments: [{ profile_id: 'p1' }] }),
    ], { mode: 'exact', mapDate: () => '2026-09-01' })
    expect(plan.blocks.map((b) => b.shiftDate)).toEqual(['2026-09-01'])
    expect(plan.rows).toHaveLength(1)
  })

  it('never ensures a block in template mode (empty source blocks included)', () => {
    const plan = buildCopyPlan([block({ shift_templates: tpl({ days_of_week: ['tue'] }) })], { mode: 'template', mapDate: () => '2026-09-01' })
    expect(plan.blocks).toEqual([])
  })

  it('does not check the template: an inactive template is still carbon-copied', () => {
    const plan = buildCopyPlan([
      block({
        shift_templates: tpl({ active: false, days_of_week: [] }),
        shift_assignments: [{ profile_id: 'p1', status: 'scheduled' }],
      }),
    ], { mode: 'exact', mapDate: weekMap })
    expect(plan.rows).toHaveLength(1)
    expect(plan.skipped).toBe(0)
  })

  it('counts coaches on an unmappable day as skipped and ensures no block for it', () => {
    const plan = buildCopyPlan([
      block({ block_date: '2026-01-31', shift_assignments: [{ profile_id: 'p1' }, { profile_id: 'p2' }] }),
    ], { mode: 'exact', mapDate: () => null })
    expect(plan).toMatchObject({ rows: [], blocks: [], skipped: 2, sourceAssignments: 2 })
  })
})

describe('buildCopyPlan — template', () => {
  it('puts the same coaches on the same slot at the TEMPLATE times, with no partial_reason or notes', () => {
    const plan = buildCopyPlan([
      block({
        start_time: '09:30:00',
        shift_assignments: [
          { profile_id: 'p1', status: 'scheduled', notes: 'keys', partial_reason: 'late', start_time_override: '09:15:00', end_time_override: '09:50:00' },
          { profile_id: 'p2', status: 'swapped' },
          { profile_id: 'p3', status: 'cancelled' },
        ],
      }),
    ], { mode: 'template', mapDate: weekMap })

    expect(plan.blocks).toEqual([])
    expect(plan.skipped).toBe(0)
    expect(plan.rows).toEqual([
      // The template says 09:00-10:00; the source block's 09:30 edit and p1's
      // own overrides are NOT carried. The writer derives an override only if
      // the target block was hand-edited away from these times.
      { profileId: 'p1', shiftTemplateId: 't1', shiftDate: '2026-07-06', startTime: '09:00:00', endTime: '10:00:00', partialReason: null, notes: null, status: 'scheduled' },
      { profileId: 'p2', shiftTemplateId: 't1', shiftDate: '2026-07-06', startTime: '09:00:00', endTime: '10:00:00', partialReason: null, notes: null, status: 'scheduled' },
    ])
  })

  it('skips coaches on a template that is now inactive', () => {
    const plan = buildCopyPlan([
      block({ shift_templates: tpl({ active: false }), shift_assignments: [{ profile_id: 'p1' }, { profile_id: 'p2', status: 'cancelled' }] }),
    ], { mode: 'template', mapDate: weekMap })
    expect(plan.rows).toEqual([])
    expect(plan.skipped).toBe(1) // cancelled was never going to be copied
  })

  it('treats a null active flag as active (column default is true)', () => {
    const plan = buildCopyPlan([
      block({ shift_templates: tpl({ active: null }), shift_assignments: [{ profile_id: 'p1' }] }),
    ], { mode: 'template', mapDate: weekMap })
    expect(plan.rows).toHaveLength(1)
  })

  it('skips coaches on a weekday the template no longer runs', () => {
    const plan = buildCopyPlan([
      // Saturday 4 Jul 2026 block on a Mon-Fri template (a one-off ad-hoc slot).
      block({ block_date: '2026-07-04', shift_assignments: [{ profile_id: 'p1' }] }),
      block({ id: 'b2', block_date: '2026-06-30', shift_templates: tpl({ days_of_week: ['mon'] }), shift_assignments: [{ profile_id: 'p2' }] }),
      block({ id: 'b3', block_date: '2026-07-01', shift_templates: tpl(), shift_assignments: [{ profile_id: 'p3' }] }),
    ], { mode: 'template', mapDate: weekMap })
    expect(plan.rows.map((r) => [r.profileId, r.shiftDate])).toEqual([['p3', '2026-07-08']])
    expect(plan.skipped).toBe(2)
  })

  it('skips when the template embed is missing entirely', () => {
    const plan = buildCopyPlan([block({ shift_templates: null, shift_assignments: [{ profile_id: 'p1' }] })], { mode: 'template', mapDate: weekMap })
    expect(plan.skipped).toBe(1)
  })

  it('checks the TARGET weekday (month mapping can change it)', () => {
    // Source Mon 1 Jun 2026 mapped by day-of-month to Wed 1 Jul 2026.
    const plan = buildCopyPlan([
      block({ block_date: '2026-06-01', shift_templates: tpl({ days_of_week: ['mon'] }), shift_assignments: [{ profile_id: 'p1' }] }),
    ], { mode: 'template', mapDate: () => '2026-07-01' })
    expect(plan.skipped).toBe(1)
  })
})

describe('buildCopyPlan — guard', () => {
  it('rejects an unknown mode', () => {
    expect(() => buildCopyPlan([], { mode: 'fuzzy', mapDate: weekMap })).toThrow(/unknown copy mode/)
  })
})

// COPYLEAVE.1 — Copy Last Week rostered coaches onto days they had booked off.
describe('buildCopyPlan — approved leave on the TARGET date', () => {
  const live = (id) => ({ profile_id: id, status: 'scheduled', notes: null, partial_reason: null, start_time_override: null, end_time_override: null })
  // Source Mon 29 Jun -> target Mon 6 Jul. p1 is off on the 6th.
  const isOnLeave = approvedLeaveLookup([
    { profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-06' },
  ])

  for (const mode of ['exact', 'template']) {
    it(`${mode}: the coach on leave is skipped and counted, the other coach is copied`, () => {
      const plan = buildCopyPlan([block({ shift_assignments: [live('p1'), live('p2')] })], { mode, mapDate: weekMap, isOnLeave })
      expect(plan.rows.map((r) => r.profileId)).toEqual(['p2'])
      expect(plan.sourceAssignments).toBe(2)
      expect(plan.skipped).toBe(1)
      expect(plan.skippedOnLeave).toBe(1)
    })
  }

  it('judges the TARGET date, not the source date', () => {
    // p1 was off on the SOURCE Monday only. They worked it anyway (they are on
    // the block), and the target Monday is a normal day: they are copied.
    const offAtSource = approvedLeaveLookup([
      { profile_id: 'p1', status: 'approved', start_date: '2026-06-29', end_date: '2026-06-29' },
    ])
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave: offAtSource })
    expect(plan.rows.map((r) => r.profileId)).toEqual(['p1'])
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('exact: the slot is still ensured on the target when its only coach is on leave, so the gap is visible', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave })
    expect(plan.rows).toEqual([])
    expect(plan.blocks.map((b) => b.shiftDate)).toEqual(['2026-07-06'])
  })

  it('PENDING leave does not skip anyone', () => {
    const pendingOnly = approvedLeaveLookup([
      { profile_id: 'p1', status: 'pending', start_date: '2026-07-06', end_date: '2026-07-06' },
    ])
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap, isOnLeave: pendingOnly })
    expect(plan.rows).toHaveLength(1)
    expect(plan.skipped).toBe(0)
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('no isOnLeave option = today\'s behaviour, and skippedOnLeave is 0 not undefined', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: weekMap })
    expect(plan.rows).toHaveLength(1)
    expect(plan.skippedOnLeave).toBe(0)
  })

  it('a day with no counterpart is NOT counted as on leave (that skip has its own reason)', () => {
    const plan = buildCopyPlan([block({ shift_assignments: [live('p1')] })], { mode: 'exact', mapDate: () => null, isOnLeave })
    expect(plan.skipped).toBe(1)
    expect(plan.skippedOnLeave).toBe(0)
  })
})

describe('mapNthWeekdayOfMonth', () => {
  it('maps the first Monday to the first Monday', () => {
    // Aug 2026: Mon 3 is the first Monday. Sep 2026: Mon 7.
    expect(mapNthWeekdayOfMonth('2026-08-03', '2026-09-01')).toBe('2026-09-07')
  })

  it('keeps the weekday for every day of a 4-week span', () => {
    for (let day = 1; day <= 28; day++) {
      const src = `2026-06-${String(day).padStart(2, '0')}`
      const mapped = mapNthWeekdayOfMonth(src, '2026-07-01')
      expect(mapped).not.toBeNull()
      expect(weekdayCodeOf(mapped)).toBe(weekdayCodeOf(src))
      expect(mapped.slice(0, 7)).toBe('2026-07')
    }
  })

  it('returns null for a 5th weekday the target month lacks', () => {
    // Jun 2026 has five Mondays (1, 8, 15, 22, 29); Feb 2027 has four.
    expect(mapNthWeekdayOfMonth('2026-06-29', '2027-02-01')).toBeNull()
    // Aug 2026 has five Mondays (3..31); Sep 2026 has four (7..28).
    expect(mapNthWeekdayOfMonth('2026-08-31', '2026-09-01')).toBeNull()
  })

  it('maps a 5th weekday when the target has one', () => {
    // Sun 29 Mar 2026 (5th Sunday, spring DST day) -> Aug 2026 5th Sunday = 30 Aug.
    expect(mapNthWeekdayOfMonth('2026-03-29', '2026-08-01')).toBe('2026-08-30')
  })

  it('crosses the autumn DST change and a year boundary', () => {
    // Sun 25 Oct 2026 is the 4th Sunday; Jan 2027's 4th Sunday is 24 Jan.
    expect(mapNthWeekdayOfMonth('2026-10-25', '2027-01-01')).toBe('2027-01-24')
    // Thu 31 Dec 2026 is the 5th Thursday; Jan 2027 has none (7..28).
    expect(mapNthWeekdayOfMonth('2026-12-31', '2027-01-01')).toBeNull()
  })
})

describe('fetchSourceBlocks', () => {
  function pagedDb(total, { failOnPage = null } = {}) {
    const calls = []
    const rows = Array.from({ length: total }, (_, i) => ({ id: `b${String(i).padStart(5, '0')}`, block_date: '2026-06-01' }))
    return {
      calls,
      from(table) {
        expect(table).toBe('shift_blocks')
        const q = { filters: [], orders: [] }
        const chain = {
          select: (s) => { q.select = s; return chain },
          eq: (c, v) => { q.filters.push(['eq', c, v]); return chain },
          gte: (c, v) => { q.filters.push(['gte', c, v]); return chain },
          lte: (c, v) => { q.filters.push(['lte', c, v]); return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (from, to) => {
            q.range = [from, to]
            calls.push(q)
            if (failOnPage !== null && calls.length - 1 === failOnPage) return Promise.resolve({ data: null, error: { message: 'boom' } })
            return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
          },
        }
        return chain
      },
    }
  }

  it('pages past the 1,000-row cap over a total order', async () => {
    const db = pagedDb(2300)
    const { blocks, error } = await fetchSourceBlocks(db, { locationId: 'loc1', startDate: '2026-06-01', endDate: '2026-06-30' })
    expect(error).toBeNull()
    expect(blocks).toHaveLength(2300)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(db.calls[0].orders).toEqual(['block_date', 'id'])
    expect(db.calls[0].filters).toEqual([
      ['eq', 'location_id', 'loc1'], ['gte', 'block_date', '2026-06-01'], ['lte', 'block_date', '2026-06-30'],
    ])
  })

  it('stops after one short page', async () => {
    const db = pagedDb(3)
    const { blocks } = await fetchSourceBlocks(db, { locationId: 'l', startDate: 'a', endDate: 'b' })
    expect(blocks).toHaveLength(3)
    expect(db.calls).toHaveLength(1)
  })

  it('returns the error (and no partial rows) when a page fails', async () => {
    const db = pagedDb(1500, { failOnPage: 1 })
    const res = await fetchSourceBlocks(db, { locationId: 'l', startDate: 'a', endDate: 'b' })
    expect(res).toEqual({ blocks: [], error: { message: 'boom' } })
  })
})

describe('fetchApprovedLeave', () => {
  // Records what was asked for and serves `total` rows a page at a time.
  function leaveDb(total, { fail = false } = {}) {
    const calls = []
    const all = Array.from({ length: total }, (_, i) => ({
      id: `l${String(i).padStart(5, '0')}`, profile_id: 'p1', status: 'approved', start_date: '2026-07-06', end_date: '2026-07-06',
    }))
    return {
      calls,
      from(table) {
        expect(table).toBe('time_off_requests')
        const q = { filters: [], orders: [] }
        const chain = {
          select: (s) => { q.select = s; return chain },
          in: (c, v) => { q.filters.push(['in', c, v]); return chain },
          eq: (c, v) => { q.filters.push(['eq', c, v]); return chain },
          lte: (c, v) => { q.filters.push(['lte', c, v]); return chain },
          gte: (c, v) => { q.filters.push(['gte', c, v]); return chain },
          order: (c) => { q.orders.push(c); return chain },
          range: (from, to) => {
            q.range = [from, to]
            calls.push(q)
            if (fail) return Promise.resolve({ data: null, error: { message: 'leave boom' } })
            return Promise.resolve({ data: all.slice(from, to + 1), error: null })
          },
        }
        return chain
      },
    }
  }

  it('asks for APPROVED leave of these coaches that overlaps the target range', async () => {
    const db = leaveDb(2)
    const { leave, error } = await fetchApprovedLeave(db, { profileIds: ['p1', 'p2'], startDate: '2026-07-06', endDate: '2026-07-12' })
    expect(error).toBeNull()
    expect(leave).toHaveLength(2)
    expect(db.calls[0].filters).toEqual([
      ['in', 'profile_id', ['p1', 'p2']],
      ['eq', 'status', 'approved'],
      // overlap: starts on or before the range ends, ends on or after it starts
      ['lte', 'start_date', '2026-07-12'],
      ['gte', 'end_date', '2026-07-06'],
    ])
    expect(db.calls[0].orders).toEqual(['start_date', 'id'])
  })

  it('pages past the 1,000-row cap', async () => {
    const db = leaveDb(1500)
    const { leave } = await fetchApprovedLeave(db, { profileIds: ['p1'], startDate: '2026-07-01', endDate: '2026-07-31' })
    expect(leave).toHaveLength(1500)
    expect(db.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('no coaches = no query', async () => {
    const db = leaveDb(5)
    expect(await fetchApprovedLeave(db, { profileIds: [], startDate: 'a', endDate: 'b' })).toEqual({ leave: [], error: null })
    expect(db.calls).toHaveLength(0)
  })

  it('returns the error and no partial rows', async () => {
    const db = leaveDb(5, { fail: true })
    expect(await fetchApprovedLeave(db, { profileIds: ['p1'], startDate: 'a', endDate: 'b' }))
      .toEqual({ leave: [], error: { message: 'leave boom' } })
  })
})

describe('copyResultToast', () => {
  it('is a success with the copied count when nothing was skipped', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 12, skipped: 0 })).toEqual({ kind: 'success', message: 'Copied 12 shifts.' })
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 1 })).toEqual({ kind: 'success', message: 'Copied 1 shift.' })
  })

  it('says why nothing new landed on a re-run', () => {
    expect(copyResultToast({ period: 'month', mode: 'template', copied: 0, skipped: 0 }).message).toMatch(/already on the target month/)
  })

  it('is a warning that names the skip reason for the mode', () => {
    const exact = copyResultToast({ period: 'month', mode: 'exact', copied: 3, skipped: 1 })
    expect(exact.kind).toBe('warning')
    expect(exact.message).toMatch(/^Copied 3 shifts\. 1 skipped, that day of the month/)
    expect(copyResultToast({ period: 'week', mode: 'template', copied: 3, skipped: 2 }).message).toMatch(/2 skipped, their template is inactive or no longer runs that weekday/)
    expect(copyResultToast({ period: 'month', mode: 'template', copied: 3, skipped: 2 }).message).toMatch(/5th Monday/)
  })

  // SLOTREMOVAL.1 — a coach skipped because the target slot was deleted gets
  // its own reason, not the mode's (which would blame a missing weekday).
  it('names deleted slots as their own skip reason', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 3, skipped: 2, skippedRemoved: 2 })).toEqual({
      kind: 'warning',
      message: 'Copied 3 shifts. 2 skipped because that slot was deleted in the target week.',
    })
    const mixed = copyResultToast({ period: 'month', mode: 'template', copied: 1, skipped: 3, skippedRemoved: 1 })
    expect(mixed.message).toBe(
      'Copied 1 shift. 1 skipped because that slot was deleted in the target month. 2 skipped, their template is inactive, no longer runs that weekday, or the target month has no matching weekday (a 5th Monday).',
    )
  })

  // COPYLEAVE.1 — a coach skipped because they are on approved leave gets that
  // reason, never the mode's ("their template is inactive").
  it('names approved leave as its own skip reason', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 9, skipped: 3, skippedOnLeave: 3 })).toEqual({
      kind: 'warning',
      message: 'Copied 9 shifts. 3 skipped, on leave.',
    })
  })

  it('lists deleted slots, leave, then the mode\'s reason, each with its own count', () => {
    const r = copyResultToast({ period: 'week', mode: 'template', copied: 1, skipped: 6, skippedRemoved: 1, skippedOnLeave: 2 })
    expect(r.message).toBe(
      'Copied 1 shift. 1 skipped because that slot was deleted in the target week. 2 skipped, on leave. 3 skipped, their template is inactive or no longer runs that weekday.',
    )
  })

  it('never claims more leave skips than there were skips', () => {
    expect(copyResultToast({ period: 'week', mode: 'exact', copied: 1, skipped: 1, skippedOnLeave: 5 }).message)
      .toBe('Copied 1 shift. 1 skipped, on leave.')
  })
})

// Roster v2 phase 5 — projectPublishImpact tests.
//
// The budget math has to get this right or every publish becomes
// either falsely blocked (alarm fatigue) or falsely waved through
// (defeats the whole point). Test the four cases that matter:
//   1. No budget set → no over-budget flag, no remaining figure.
//   2. Under budget → overBudget=false, remaining > 0.
//   3. Over budget → overBudget=true, overrun = total - budget.
//   4. Already-published-in-month-outside-period adds to the
//      total (publish is the last shoe to drop, not the only one).

import { describe, it, expect } from 'vitest'
import { projectPublishImpact, findConflictingPublishedRosters } from './roster-publish'

function mockDb({ location, contractors = [], blocks = [], timeOff = [] }) {
  // Mock the chained Supabase queries the helper makes:
  //   from('locations').select(...).eq(...).single() → location
  //   from('profile_locations').select(...).eq(...) → contractor links
  //   from('shift_blocks').select(...).eq().gte().lte() → blocks
  const calls = []
  return {
    from(table) {
      calls.push(table)
      if (table === 'locations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: location, error: null }),
            }),
          }),
        }
      }
      if (table === 'profile_locations') {
        return {
          select: () => ({
            eq: async () => ({
              data: contractors.map(c => ({
                profile_id: c.id,
                profiles: c,
              })),
              error: null,
            }),
          }),
        }
      }
      // ROSTER-FIX.4 — approved leave for the month, one query.
      if (table === 'time_off_requests') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          lte: () => chain,
          gte: (col) => (col === 'end_date'
            ? Promise.resolve({ data: timeOff, error: null })
            : chain),
        }
        return chain
      }
      if (table === 'shift_blocks') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                lte: async () => ({ data: blocks, error: null }),
              }),
            }),
          }),
        }
      }
      throw new Error('unexpected table: ' + table)
    },
  }
}

const dan = { id: 'dan', employment_type: 'contractor', hourly_rate: 35, active: true }
const eve = { id: 'eve', employment_type: 'contractor', hourly_rate: 40, active: true }
const sarah = { id: 'sarah', employment_type: 'fte', hourly_rate: null, active: true }

function block({ id, date, start, end, coaches = [], roster = null }) {
  return {
    id,
    location_id: 'loc1',
    block_date: date,
    start_time: start,
    end_time: end,
    roster_id: roster?.id || null,
    rosters: roster,
    // A coach entry is either a profile id (live) or a full { profile_id, status } row.
    shift_assignments: coaches.map(c => (typeof c === 'string' ? { profile_id: c, status: 'scheduled' } : c)),
  }
}

describe('projectPublishImpact', () => {
  // ROSTER-FIX.1 — a cancelled assignment costs nothing, so it must never
  // push a publish over the contractor budget.
  it('excludes cancelled assignments from the projected spend', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan, eve],
      blocks: [block({
        id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00',
        coaches: ['dan', { profile_id: 'eve', status: 'cancelled' }],
      })],
    })
    const impact = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    // dan 2h × 35 = 70; eve's cancelled 2h × 40 must not be added.
    expect(impact.periodProjectedEur).toBe(70)
  })

  it('returns null budget + remaining when location has no budget set', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: null },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] })],
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.monthlyBudgetEur).toBeNull()
    expect(r.remainingEur).toBeNull()
    expect(r.overBudget).toBe(false)
    expect(r.periodProjectedEur).toBe(70) // 2h × 35
  })

  it('flags overBudget=false and computes remaining when under', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] })],
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.periodProjectedEur).toBe(70)
    expect(r.alreadyPublishedEur).toBe(0)
    expect(r.monthProjectedTotalEur).toBe(70)
    expect(r.remainingEur).toBe(430)
    expect(r.overBudget).toBe(false)
    expect(r.overrunEur).toBe(0)
  })

  it('flags overBudget=true with positive overrun when over', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 50 },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['dan'] })], // 4h × 35 = 140
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.monthProjectedTotalEur).toBe(140)
    expect(r.overBudget).toBe(true)
    expect(r.overrunEur).toBe(90)
    expect(r.remainingEur).toBe(-90)
  })

  it('adds already-published-this-month-outside-period to the running total', async () => {
    const publishedRoster = { id: 'r-published', status: 'published' }
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 200 },
      contractors: [dan, eve],
      blocks: [
        // Already published earlier in the month — counts toward total
        block({ id: 'past', date: '2026-05-01', start: '09:00', end: '12:00', coaches: ['dan'], roster: publishedRoster }), // 3h × 35 = 105
        // About to publish (this period)
        block({ id: 'new', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['eve'] }), // 2h × 40 = 80
      ],
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.alreadyPublishedEur).toBe(105)
    expect(r.periodProjectedEur).toBe(80)
    expect(r.monthProjectedTotalEur).toBe(185)
    expect(r.remainingEur).toBe(15)
    expect(r.overBudget).toBe(false)
  })

  it('ignores draft-roster blocks outside the period (only published count)', async () => {
    const draftRoster = { id: 'r-draft', status: 'draft' }
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan],
      blocks: [
        // Outside period, on a DRAFT roster — does NOT count toward
        // the budget total (only published spend consumes budget).
        block({ id: 'draft-outside', date: '2026-05-15', start: '09:00', end: '12:00', coaches: ['dan'], roster: draftRoster }),
        // Inside period — counts as projected
        block({ id: 'new', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] }),
      ],
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.alreadyPublishedEur).toBe(0)
    expect(r.periodProjectedEur).toBe(70)
    expect(r.monthProjectedTotalEur).toBe(70)
  })

  it('FTE coaches do NOT add to contractor cost', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 100 },
      contractors: [dan, sarah],  // sarah is FTE — won't be in the rate map
      blocks: [
        block({ id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00', coaches: ['sarah'] }), // 4h FTE = €0
        block({ id: 'b2', date: '2026-05-05', start: '09:00', end: '11:00', coaches: ['dan'] }),   // 2h × 35 = €70
      ],
    })
    const r = await projectPublishImpact(db, {
      locationId: 'loc1',
      periodStart: '2026-05-04',
      periodEnd: '2026-05-10',
    })
    expect(r.periodProjectedEur).toBe(70)
    expect(r.blockCount).toBe(1)  // FTE-only block doesn't count (cost=0)
  })
})

// ROSTER-FIX.4 — the budget gate priced every assignment at the BLOCK's
// window and ignored approved leave, so the number the owner signed off on
// was not the number that would be paid.
describe('projectPublishImpact — per-assignment overrides and approved leave', () => {
  it('prices an assignment by its OVERRIDE window, not the block default', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [block({
        id: 'b1', date: '2026-05-04', start: '09:00', end: '13:00',   // block says 4h
        coaches: [{ profile_id: 'dan', status: 'scheduled', start_time_override: '09:00', end_time_override: '10:00' }],
      })],
    })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
    // 1h × 35, not the block's 4h × 35.
    expect(r.periodProjectedEur).toBe(35)
  })

  it('prices coaches on the same block independently', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan, eve],
      blocks: [block({
        id: 'b1', date: '2026-05-04', start: '09:00', end: '11:00',
        coaches: [
          { profile_id: 'dan', status: 'scheduled' },                                             // 2h × 35 = 70
          { profile_id: 'eve', status: 'scheduled', start_time_override: '09:00', end_time_override: '12:00' }, // 3h × 40 = 120
        ],
      })],
    })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
    expect(r.periodProjectedEur).toBe(190)
  })

  it('costs nothing for an assignment inside the coach\u2019s APPROVED leave', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan, eve],
      blocks: [block({
        id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00',
        coaches: ['dan', 'eve'],
      })],
      timeOff: [{ profile_id: 'dan', start_date: '2026-05-04', end_date: '2026-05-08' }],
    })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
    // dan is on leave that day; only eve's 2h × 40 is projected.
    expect(r.periodProjectedEur).toBe(80)
  })

  it('leave on OTHER dates leaves the projection alone', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [block({ id: 'b1', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['dan'] })],
      timeOff: [{ profile_id: 'dan', start_date: '2026-05-20', end_date: '2026-05-22' }],
    })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
    expect(r.periodProjectedEur).toBe(70)
  })

  it('leave is inclusive of both its first and last day', async () => {
    const db = mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: 500 },
      contractors: [dan],
      blocks: [
        block({ id: 'b-first', date: '2026-05-04', start: '09:00', end: '11:00', coaches: ['dan'] }),
        block({ id: 'b-last', date: '2026-05-06', start: '09:00', end: '11:00', coaches: ['dan'] }),
        block({ id: 'b-after', date: '2026-05-07', start: '09:00', end: '11:00', coaches: ['dan'] }),
      ],
      timeOff: [{ profile_id: 'dan', start_date: '2026-05-04', end_date: '2026-05-06' }],
    })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' })
    // Only the 7th is billable: 2h × 35.
    expect(r.periodProjectedEur).toBe(70)
  })
})


// ROSTER-FIX.4 — the overlap guard. Two published rosters covering one day at
// one location make "which roster published this day" unanswerable, because
// publishing rewrites shift_blocks.roster_id across the whole period and the
// older row keeps claiming dates it owns no blocks for. The helper is shared
// by POST /api/schedule/rosters and the approve endpoint, which is the point:
// a guard only one of the two publish paths ran was no guard at all.
describe('findConflictingPublishedRosters', () => {
  // Records the filters the helper builds and answers with `rows`, so the
  // date-window query is pinned as well as the containment filtering.
  function mockDb(rows, error = null) {
    const calls = []
    const chain = {
      select(cols) { calls.push(['select', cols]); return chain },
      eq(col, val) { calls.push(['eq', col, val]); return chain },
      lte(col, val) { calls.push(['lte', col, val]); return chain },
      gte(col, val) { calls.push(['gte', col, val]); return chain },
      neq(col, val) { calls.push(['neq', col, val]); return chain },
      then: (onF, onR) => Promise.resolve({ data: rows, error }).then(onF, onR),
    }
    return { db: { from: (t) => { calls.push(['from', t]); return chain } }, calls }
  }

  const WEEK = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' }

  it('queries published rosters at the location over the inclusive date window', async () => {
    const { db, calls } = mockDb([])
    const res = await findConflictingPublishedRosters(db, WEEK)
    expect(res).toEqual({ conflicts: [], error: null })
    expect(calls).toContainEqual(['from', 'rosters'])
    expect(calls).toContainEqual(['eq', 'location_id', 'loc1'])
    expect(calls).toContainEqual(['eq', 'status', 'published'])
    // Overlap = starts on or before our end AND ends on or after our start.
    expect(calls).toContainEqual(['lte', 'period_start', '2026-05-10'])
    expect(calls).toContainEqual(['gte', 'period_end', '2026-05-04'])
    // No exclusion asked for → no neq narrowing the guard.
    expect(calls.some((c) => c[0] === 'neq')).toBe(false)
  })

  it('an EXACT re-publish of the same period is not a conflict (that is the re-notify path)', async () => {
    const { db } = mockDb([{ id: 'r-same', period_start: '2026-05-04', period_end: '2026-05-10' }])
    const { conflicts, error } = await findConflictingPublishedRosters(db, WEEK)
    expect(error).toBeNull()
    expect(conflicts).toEqual([])
  })

  it('a period that CONTAINS the published one is not a conflict (week → month)', async () => {
    const { db } = mockDb([{ id: 'r-week', period_start: '2026-05-04', period_end: '2026-05-10' }])
    const { conflicts } = await findConflictingPublishedRosters(db, {
      locationId: 'loc1', periodStart: '2026-05-01', periodEnd: '2026-05-31',
    })
    expect(conflicts).toEqual([])
  })

  it('a week INSIDE an already-published month is a conflict', async () => {
    const month = { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }
    const { db } = mockDb([month])
    const { conflicts } = await findConflictingPublishedRosters(db, WEEK)
    expect(conflicts).toEqual([month])
  })

  it('a period straddling either EDGE of a published one is a conflict', async () => {
    const before = { id: 'r-prev', period_start: '2026-04-27', period_end: '2026-05-05' }
    const after = { id: 'r-next', period_start: '2026-05-09', period_end: '2026-05-17' }
    const { db } = mockDb([before, after])
    const { conflicts } = await findConflictingPublishedRosters(db, WEEK)
    expect(conflicts).toEqual([before, after])
  })

  it('reports only the overlapping rows, keeping the contained ones out of the 409', async () => {
    const month = { id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }
    const inner = { id: 'r-inner', period_start: '2026-05-05', period_end: '2026-05-06' }
    const { db } = mockDb([month, inner])
    const { conflicts } = await findConflictingPublishedRosters(db, WEEK)
    expect(conflicts).toEqual([month])
  })

  it('excludeRosterId keeps a roster from conflicting with itself (the approve path)', async () => {
    const { db, calls } = mockDb([])
    await findConflictingPublishedRosters(db, { ...WEEK, excludeRosterId: 'roster-1' })
    expect(calls).toContainEqual(['neq', 'id', 'roster-1'])
  })

  it('surfaces a query error instead of reporting "no conflicts"', async () => {
    const { db } = mockDb(null, { message: 'boom' })
    const { conflicts, error } = await findConflictingPublishedRosters(db, WEEK)
    // A failed probe must never read as a clean bill of health.
    expect(conflicts).toEqual([])
    expect(error).toEqual({ message: 'boom' })
  })

  it('treats a null data set as no conflicts', async () => {
    const { db } = mockDb(null)
    const { conflicts, error } = await findConflictingPublishedRosters(db, WEEK)
    expect(conflicts).toEqual([])
    expect(error).toBeNull()
  })
})

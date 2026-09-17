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

import { describe, it, expect, afterEach } from 'vitest'
import {
  projectPublishImpact,
  projectionChanged,
  monthsTouched,
  findConflictingPublishedRosters,
  releasePublishedRostersFor,
  restorePublishedRosters,
  supersedeSwallowedRosters,
} from './roster-publish'

function mockDb({ location, contractors = [], blocks = [], timeOff = [] }) {
  // Mock the chained Supabase queries the helper makes:
  //   from('locations').select(...).eq(...).single() → location
  //   from('profile_locations').select(...).eq(...) → contractor links
  //   from('shift_blocks').select(...).eq().gte().lte() → blocks
  const calls = []
  const blockQueries = []
  return {
    blockQueries,
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
      // BUDGETAPPROVE.1 — the block read now spans every month the period
      // touches and pages with .order().range(), so the mock honours the date
      // bounds and the page window: a helper that asked for the wrong months
      // must get the wrong blocks back, not every fixture regardless.
      if (table === 'shift_blocks') {
        const f = { gte: null, lte: null, from: 0, to: Infinity }
        blockQueries.push(f)
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          gte: (_c, v) => { f.gte = v; return chain },
          lte: (_c, v) => { f.lte = v; return chain },
          range: (from, to) => { f.from = from; f.to = to; return chain },
          then: (onF, onR) => Promise.resolve({
            data: blocks
              .filter((b) => (f.gte == null || b.block_date >= f.gte) && (f.lte == null || b.block_date <= f.lte))
              .slice(f.from, f.to + 1),
            error: null,
          }).then(onF, onR),
        }
        return chain
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
// BUDGETAPPROVE.1 — the projection loaded only the month period_start falls
// in, so a week running into the next month lost those days entirely: the
// 31 Aug-6 Sep draft was stored at EUR 99.96 against a real EUR 689.95. The
// budget is monthly, so each month is judged on its own.
describe('projectPublishImpact — a period that crosses a month boundary', () => {
  const realTz = process.env.TZ
  afterEach(() => { process.env.TZ = realTz })

  // Mon 31 Aug + Tue 1 Sep..Sun 6 Sep, 2h x EUR 35 = EUR 70 each day.
  function crossMonthDb({ budget = 500 } = {}) {
    const days = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']
    const published = { id: 'r-old', status: 'published' }
    return mockDb({
      location: { id: 'loc1', monthly_contractor_budget_eur: budget },
      contractors: [dan],
      blocks: [
        ...days.map((d, i) => block({ id: `w${i}`, date: d, start: '09:00', end: '11:00', coaches: ['dan'] })),
        // Already published elsewhere in each month, outside the period.
        block({ id: 'aug-pub', date: '2026-08-10', start: '09:00', end: '13:00', coaches: ['dan'], roster: published }), // 140
        block({ id: 'sep-pub', date: '2026-09-20', start: '09:00', end: '12:00', coaches: ['dan'], roster: published }), // 105
        // Outside both months: must never be loaded or counted.
        block({ id: 'oct-pub', date: '2026-10-01', start: '09:00', end: '17:00', coaches: ['dan'], roster: published }),
      ],
    })
  }

  for (const tz of ['Europe/Dublin', 'America/New_York']) {
    it(`prices every day of 31 Aug-6 Sep and splits it per month (TZ=${tz})`, async () => {
      process.env.TZ = tz
      const db = crossMonthDb()
      const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-06' })

      // The whole period, not just Monday.
      expect(r.periodProjectedEur).toBe(490)
      expect(r.blockCount).toBe(7)
      expect(r.months).toEqual([
        {
          monthStart: '2026-08-01', monthEnd: '2026-08-31', monthlyBudgetEur: 500,
          alreadyPublishedEur: 140, periodProjectedEur: 70, monthProjectedTotalEur: 210,
          remainingEur: 290, overBudget: false, overrunEur: 0, blockCount: 1,
        },
        {
          monthStart: '2026-09-01', monthEnd: '2026-09-30', monthlyBudgetEur: 500,
          alreadyPublishedEur: 105, periodProjectedEur: 420, monthProjectedTotalEur: 525,
          remainingEur: -25, overBudget: true, overrunEur: 25, blockCount: 6,
        },
      ])
      // Top level: any month over is over; the month line quotes September,
      // the binding month, never Aug+Sep summed against one month's budget.
      expect(r.overBudget).toBe(true)
      expect(r.overrunEur).toBe(25)
      expect(r.monthStart).toBe('2026-09-01')
      expect(r.monthEnd).toBe('2026-09-30')
      expect(r.monthProjectedTotalEur).toBe(525)
      expect(r.remainingEur).toBe(-25)
      expect(r.alreadyPublishedEur).toBe(245)
      // One read spanning both months, bounded to them.
      expect(db.blockQueries[0]).toMatchObject({ gte: '2026-08-01', lte: '2026-09-30' })
    })
  }

  it('a month under budget does not absorb the other month\'s overrun', async () => {
    // August has EUR 290 headroom; September is EUR 25 over. Summed, the two
    // months would read as comfortably inside a EUR 1000 two-month allowance.
    const r = await projectPublishImpact(crossMonthDb(), { locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-06' })
    expect(r.months[0].overBudget).toBe(false)
    expect(r.overBudget).toBe(true)
  })

  it('sums overruns when more than one month is over', async () => {
    const r = await projectPublishImpact(crossMonthDb({ budget: 200 }), { locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-06' })
    expect(r.months.map((m) => m.overrunEur)).toEqual([10, 325])
    expect(r.overrunEur).toBe(335)
    expect(r.monthStart).toBe('2026-09-01')
  })

  it('a period inside one month keeps its old shape, with a one-month breakdown', async () => {
    const r = await projectPublishImpact(crossMonthDb(), { locationId: 'loc1', periodStart: '2026-09-01', periodEnd: '2026-09-06' })
    expect(r.months).toHaveLength(1)
    expect(r.monthStart).toBe('2026-09-01')
    expect(r.periodProjectedEur).toBe(420)
    expect(r.monthProjectedTotalEur).toBe(525)
  })

  it('pages the block read past the 1000-row cap', async () => {
    const blocks = Array.from({ length: 1001 }, (_, i) => block({
      id: `b${String(i).padStart(4, '0')}`, date: '2026-09-02', start: '09:00', end: '10:00', coaches: ['dan'],
    }))
    const db = mockDb({ location: { id: 'loc1', monthly_contractor_budget_eur: null }, contractors: [dan], blocks })
    const r = await projectPublishImpact(db, { locationId: 'loc1', periodStart: '2026-08-31', periodEnd: '2026-09-06' })
    expect(r.blockCount).toBe(1001)
    expect(db.blockQueries.map((q) => [q.from, q.to])).toEqual([[0, 999], [1000, 1999]])
  })
})

describe('monthsTouched', () => {
  it('lists every month a period touches, across a year end', () => {
    expect(monthsTouched('2026-12-28', '2027-02-03')).toEqual([
      { monthStart: '2026-12-01', monthEnd: '2026-12-31' },
      { monthStart: '2027-01-01', monthEnd: '2027-01-31' },
      { monthStart: '2027-02-01', monthEnd: '2027-02-28' },
    ])
  })
})

describe('projectionChanged', () => {
  const impact = { periodProjectedEur: 689.95, monthlyBudgetEur: 5000 }
  it('is false when the stored snapshot matches to the cent (numeric columns come back as strings)', () => {
    expect(projectionChanged({ projected_contractor_eur: '689.95', budget_at_publish_eur: '5000' }, impact)).toBe(false)
  })
  it('is true when the period cost moved', () => {
    expect(projectionChanged({ projected_contractor_eur: 99.96, budget_at_publish_eur: 5000 }, impact)).toBe(true)
  })
  it('is true when a budget was set or cleared since', () => {
    expect(projectionChanged({ projected_contractor_eur: 689.95, budget_at_publish_eur: null }, impact)).toBe(true)
    expect(projectionChanged({ projected_contractor_eur: 689.95, budget_at_publish_eur: 5000 }, { ...impact, monthlyBudgetEur: null })).toBe(true)
  })
})

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


// ROSTER-SUPERSEDE.1 — a publish supersedes the rosters it swallows.
//
// The model, verified against prod: publishing INSERTs a rosters row and
// re-tags every shift_blocks.roster_id in the period, so ownership is PER
// BLOCK and a roster's period is the request that produced it, not a claim.
// Mig 602 turns that into a rule (no two published rosters over one day at
// one location), which means the app has to resolve the swallowing itself
// instead of leaving a row claiming days it owns nothing on.
describe('releasePublishedRostersFor', () => {
  // The rosters table serves two different selects here, told apart by the
  // filters: release asks for CONTAINED rows (gte period_start / lte
  // period_end), the post-retag scan asks for OVERLAPPING ones.
  function db({ contained = [], selectError = null, updateError = null, failUpdateAt = null } = {}) {
    const updates = []
    const filters = []
    // ROSTER-SUPERSEDE.1 — failUpdateAt is an index (that write fails with
    // 'write failed') or an { index: message } map, which is what lets a test
    // fail the release write AND the restore that answers it.
    const failures = failUpdateAt === null
      ? {}
      : (typeof failUpdateAt === 'number' ? { [failUpdateAt]: 'write failed' } : failUpdateAt)
    return {
      updates,
      filters,
      client: {
        from(table) {
          if (table !== 'rosters') throw new Error('unexpected table: ' + table)
          const chain = {
            select: (c) => { filters.push(['select', c]); return chain },
            eq: (c, v) => { filters.push(['eq', c, v]); return chain },
            gte: (c, v) => { filters.push(['gte', c, v]); return chain },
            lte: (c, v) => { filters.push(['lte', c, v]); return chain },
            neq: (c, v) => { filters.push(['neq', c, v]); return chain },
            in: (c, v) => { filters.push(['in', c, v]); return chain },
            is: (c, v) => { filters.push(['is', c, v]); return chain },
            then: (onF, onR) => Promise.resolve({ data: contained, error: selectError }).then(onF, onR),
            update(payload) {
              const idx = updates.length
              updates.push(payload)
              const err = failures[idx] ? { message: failures[idx] } : updateError
              const w = {
                eq: () => w,
                in: () => w,
                is: () => w,
                then: (onF, onR) => Promise.resolve({ data: null, error: err }).then(onF, onR),
              }
              return w
            },
          }
          return chain
        },
      },
    }
  }

  const WEEK = { locationId: 'loc1', periodStart: '2026-05-04', periodEnd: '2026-05-10' }

  it('releases the published rosters this period fully contains, BEFORE the insert', async () => {
    const m = db({ contained: [{ id: 'r-old', period_start: '2026-05-04', period_end: '2026-05-10' }] })
    const res = await releasePublishedRostersFor(m.client, WEEK)
    expect(res.error).toBeNull()
    expect(res.released).toEqual([{ id: 'r-old', period_start: '2026-05-04', period_end: '2026-05-10' }])
    // Containment, not overlap: only a roster the new period swallows whole.
    expect(m.filters).toContainEqual(['eq', 'status', 'published'])
    expect(m.filters).toContainEqual(['gte', 'period_start', '2026-05-04'])
    expect(m.filters).toContainEqual(['lte', 'period_end', '2026-05-10'])
    expect(m.updates[0].status).toBe('superseded')
    // superseded_by cannot be stamped yet — the successor does not exist.
    expect(m.updates[0].superseded_by).toBeNull()
  })

  it('is a no-op when nothing is contained', async () => {
    const m = db({ contained: [] })
    const res = await releasePublishedRostersFor(m.client, WEEK)
    expect(res.released).toEqual([])
    expect(m.updates).toHaveLength(0)
  })

  it('excludes the roster being published (the approve path re-checks itself)', async () => {
    const m = db({ contained: [] })
    await releasePublishedRostersFor(m.client, { ...WEEK, excludeRosterId: 'roster-1' })
    expect(m.filters).toContainEqual(['neq', 'id', 'roster-1'])
  })

  it('surfaces a failed probe instead of reporting nothing to release', async () => {
    const m = db({ contained: null, selectError: { message: 'boom' } })
    const res = await releasePublishedRostersFor(m.client, WEEK)
    expect(res.released).toEqual([])
    expect(res.error).toEqual({ message: 'boom' })
    expect(m.updates).toHaveLength(0)
  })

  it('restores what it already released when a release write fails', async () => {
    // A half-released set is worse than none: the insert would still trip the
    // exclusion constraint AND the half-superseded rosters' blocks would read
    // as unpublished.
    const m = db({
      contained: [
        { id: 'r-a', period_start: '2026-05-04', period_end: '2026-05-06' },
        { id: 'r-b', period_start: '2026-05-07', period_end: '2026-05-10' },
      ],
      failUpdateAt: 1,
    })
    const res = await releasePublishedRostersFor(m.client, WEEK)
    expect(res.error).toEqual({ message: 'write failed' })
    expect(res.released).toEqual([])
    // A restore that WORKED adds nothing to the error the caller reports.
    expect(res.error.message).not.toMatch(/could not be restored/)
    // r-a was released, r-b's write failed; the last write is r-a going back.
    expect(m.updates).toHaveLength(3)
    expect(m.updates.at(-1)).toEqual({ status: 'published', superseded_at: null, superseded_by: null })
  })

  it('folds a FAILED restore into the error and NAMES the stranded rosters', async () => {
    // The restore is itself a write: it can lose to the same blip, or hit a
    // legitimate 23P01 because another publish took the range meanwhile.
    // Discarding that left rosters stood down with nobody told.
    const m = db({
      contained: [
        { id: 'r-a', period_start: '2026-05-04', period_end: '2026-05-06' },
        { id: 'r-b', period_start: '2026-05-07', period_end: '2026-05-10' },
      ],
      failUpdateAt: {
        1: 'write failed',
        2: '23P01 conflicting key value violates exclusion constraint "rosters_no_overlapping_published"',
      },
    })
    const res = await releasePublishedRostersFor(m.client, WEEK)
    expect(res.released).toEqual([])
    expect(res.error.message).toMatch(/write failed/)
    expect(res.error.message).toMatch(/23P01/)
    expect(res.error.message).toMatch(/could not be restored/)
    // r-a is still superseded and nothing else will put it back, so the
    // message has to name it.
    expect(res.error.message).toMatch(/r-a/)
  })
})

describe('restorePublishedRosters', () => {
  function db({ updateError = null } = {}) {
    const updates = []
    return {
      updates,
      client: {
        from() {
          return {
            update(payload) {
              updates.push(payload)
              const w = {
                in: () => w,
                eq: () => w,
                then: (onF, onR) => Promise.resolve({ data: null, error: updateError }).then(onF, onR),
              }
              return w
            },
          }
        },
      },
    }
  }

  it('puts released rosters back to published when the publish never happened', async () => {
    const m = db()
    const { error } = await restorePublishedRosters(m.client, [{ id: 'r-a' }, { id: 'r-b' }])
    expect(error).toBeNull()
    expect(m.updates).toEqual([{ status: 'published', superseded_at: null, superseded_by: null }])
  })

  it('does nothing, and does not error, on an empty list', async () => {
    const m = db()
    const { error } = await restorePublishedRosters(m.client, [])
    expect(error).toBeNull()
    expect(m.updates).toHaveLength(0)
  })

  it('reports a failed restore rather than swallowing it', async () => {
    const m = db({ updateError: { message: 'nope' } })
    const { error } = await restorePublishedRosters(m.client, [{ id: 'r-a' }])
    expect(error).toEqual({ message: 'nope' })
  })
})

describe('supersedeSwallowedRosters', () => {
  // rosters: the overlap scan (lte period_start / gte period_end) + updates.
  // shift_blocks: a head count per roster, then min/max block_date.
  function db({ overlapping = [], blocks = {}, scanError = null, countError = null, updateError = null, stampedIds = null } = {}) {
    const updates = []
    const filters = []
    const client = {
      from(table) {
        if (table === 'rosters') {
          const chain = {
            select: (c) => { filters.push(['select', c]); return chain },
            eq: (c, v) => { filters.push(['eq', c, v]); return chain },
            gte: (c, v) => { filters.push(['gte', c, v]); return chain },
            lte: (c, v) => { filters.push(['lte', c, v]); return chain },
            neq: (c, v) => { filters.push(['neq', c, v]); return chain },
            in: (c, v) => { filters.push(['in', c, v]); return chain },
            is: (c, v) => { filters.push(['is', c, v]); return chain },
            then: (onF, onR) => Promise.resolve({ data: overlapping, error: scanError }).then(onF, onR),
            update(payload) {
              const rec = { payload, where: [] }
              updates.push(rec)
              const w = {
                eq: (c, v) => { rec.where.push([c, v]); return w },
                in: (c, v) => { rec.where.push([c, v]); return w },
                is: (c, v) => { rec.where.push([c, v]); return w },
                // ROSTER-SUPERSEDE.1 — the superseded_by stamp reads back the
                // rows it TOUCHED. By default every targeted id matched;
                // `stampedIds` is how a test makes the write miss.
                select: () => ({
                  then: (onF, onR) => {
                    const targeted = rec.where.find(([c]) => c === 'id')?.[1]
                    const all = Array.isArray(targeted) ? targeted : [targeted].filter(Boolean)
                    const ids = stampedIds === null ? all : stampedIds
                    return Promise.resolve({
                      data: updateError ? null : ids.map((id) => ({ id })),
                      error: updateError,
                    }).then(onF, onR)
                  },
                }),
                then: (onF, onR) => Promise.resolve({ data: null, error: updateError }).then(onF, onR),
              }
              return w
            },
          }
          return chain
        }
        if (table === 'shift_blocks') {
          let rosterId = null
          let asc = true
          let head = false
          const chain = {
            select: (_c, opts) => { head = !!opts?.head; return chain },
            eq: (c, v) => { if (c === 'roster_id') rosterId = v; return chain },
            order: (_c, o) => { asc = o?.ascending !== false; return chain },
            limit: () => chain,
            maybeSingle: () => {
              const dates = blocks[rosterId] || []
              const sorted = [...dates].sort()
              const pick = asc ? sorted[0] : sorted[sorted.length - 1]
              return Promise.resolve({ data: pick ? { block_date: pick } : null, error: countError })
            },
            then: (onF, onR) => Promise.resolve(
              head
                ? { data: null, count: (blocks[rosterId] || []).length, error: countError }
                : { data: (blocks[rosterId] || []).map((d) => ({ block_date: d })), error: countError },
            ).then(onF, onR),
          }
          return chain
        }
        throw new Error('unexpected table: ' + table)
      },
    }
    return { client, updates, filters }
  }

  const ARGS = {
    locationId: 'loc1',
    newRosterId: 'r-new',
    periodStart: '2026-05-04',
    periodEnd: '2026-05-10',
  }

  it('stamps superseded_by on the rosters released before the insert', async () => {
    const m = db({ overlapping: [] })
    const res = await supersedeSwallowedRosters(m.client, { ...ARGS, releasedIds: ['r-old'] })
    expect(res.warning).toBeNull()
    expect(res.superseded).toEqual(['r-old'])
    const stamp = m.updates.find((u) => u.payload.superseded_by === 'r-new')
    expect(stamp).toBeTruthy()
    // Only rows that do not already name a successor.
    expect(stamp.where).toContainEqual(['superseded_by', null])
  })

  it('reports only the rows the stamp actually TOUCHED, not the rows it aimed at', async () => {
    // A racing publish can flip a released row back or stamp its own successor
    // first, and all three of the stamp's filters then miss. Reporting the
    // aimed-at ids as superseded hid exactly the attribution gap this closes.
    const m = db({ overlapping: [], stampedIds: ['r-a'] })
    const res = await supersedeSwallowedRosters(m.client, { ...ARGS, releasedIds: ['r-a', 'r-b'] })
    expect(res.superseded).toEqual(['r-a'])
    expect(res.warning).toMatch(/r-b/)
  })

  it('warns rather than claiming success when the stamp matches nothing at all', async () => {
    const m = db({ overlapping: [], stampedIds: [] })
    const res = await supersedeSwallowedRosters(m.client, { ...ARGS, releasedIds: ['r-old'] })
    expect(res.superseded).toEqual([])
    expect(res.warning).toMatch(/superseded_by stamp matched no row for: r-old/)
  })

  it('supersedes an overlapping published roster that now owns ZERO blocks', async () => {
    const m = db({
      overlapping: [{ id: 'r-old', period_start: '2026-05-04', period_end: '2026-05-10' }],
      blocks: { 'r-old': [] },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.superseded).toEqual(['r-old'])
    const u = m.updates.find((x) => x.where.some(([c, v]) => c === 'id' && v === 'r-old'))
    expect(u.payload.status).toBe('superseded')
    expect(u.payload.superseded_by).toBe('r-new')
    expect(u.payload.superseded_at).toBeTruthy()
  })

  it('shrinks a roster that still owns blocks instead of superseding it', async () => {
    const m = db({
      overlapping: [{ id: 'r-old', period_start: '2026-05-01', period_end: '2026-05-31' }],
      blocks: { 'r-old': ['2026-05-20', '2026-05-25'] },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.superseded).toEqual([])
    expect(res.shrunk).toEqual([{ id: 'r-old', period_start: '2026-05-20', period_end: '2026-05-25' }])
    const u = m.updates.find((x) => x.where.some(([c, v]) => c === 'id' && v === 'r-old'))
    expect(u.payload).toEqual({ period_start: '2026-05-20', period_end: '2026-05-25' })
    // requested_period_* is the operator's original ask and is never rewritten.
    expect(u.payload).not.toHaveProperty('requested_period_start')
    expect(u.payload).not.toHaveProperty('requested_period_end')
  })

  it('leaves a roster alone when its owned range already matches its period', async () => {
    const m = db({
      overlapping: [{ id: 'r-old', period_start: '2026-05-20', period_end: '2026-05-25' }],
      blocks: { 'r-old': ['2026-05-20', '2026-05-25'] },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.shrunk).toEqual([])
    expect(m.updates).toHaveLength(0)
  })

  it('NEVER touches the roster that was just published', async () => {
    // Ordering trap: the new roster overlaps its own period by definition, so
    // without the exclusion it would supersede itself the moment the re-tag
    // had not yet been read back.
    const m = db({
      overlapping: [{ id: 'r-new', period_start: '2026-05-04', period_end: '2026-05-10' }],
      blocks: { 'r-new': [] },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.superseded).toEqual([])
    expect(m.updates).toHaveLength(0)
    expect(m.filters).toContainEqual(['neq', 'id', 'r-new'])
  })

  it('refuses to run at all without a new roster id', async () => {
    const m = db({ overlapping: [{ id: 'r-old', period_start: '2026-05-04', period_end: '2026-05-10' }] })
    const res = await supersedeSwallowedRosters(m.client, { ...ARGS, newRosterId: null })
    expect(res.warning).toMatch(/newRosterId/)
    expect(m.updates).toHaveLength(0)
  })

  it('reports a failed scan as a warning rather than a clean sweep', async () => {
    const m = db({ overlapping: null, scanError: { message: 'boom' } })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.warning).toMatch(/boom/)
    expect(res.superseded).toEqual([])
  })

  it('reports a failed block recount without superseding on a guess', async () => {
    const m = db({
      overlapping: [{ id: 'r-old', period_start: '2026-05-04', period_end: '2026-05-10' }],
      blocks: { 'r-old': [] },
      countError: { message: 'count boom' },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.warning).toMatch(/count boom/)
    // A roster whose ownership could not be read is left published — reading a
    // failed count as "owns nothing" would unpublish its blocks.
    expect(res.superseded).toEqual([])
    expect(m.updates).toHaveLength(0)
  })

  it('reports a failed write and keeps going through the rest', async () => {
    const m = db({
      overlapping: [
        { id: 'r-a', period_start: '2026-05-04', period_end: '2026-05-06' },
        { id: 'r-b', period_start: '2026-05-07', period_end: '2026-05-10' },
      ],
      blocks: { 'r-a': [], 'r-b': [] },
      updateError: { message: 'write boom' },
    })
    const res = await supersedeSwallowedRosters(m.client, ARGS)
    expect(res.warning).toMatch(/write boom/)
    // Both were attempted — a failure on the first must not skip the second.
    expect(m.updates).toHaveLength(2)
    expect(res.superseded).toEqual([])
  })

  it('never throws, whatever the client does', async () => {
    const exploding = { from() { throw new Error('client is gone') } }
    const res = await supersedeSwallowedRosters(exploding, ARGS)
    expect(res.warning).toMatch(/client is gone/)
  })
})

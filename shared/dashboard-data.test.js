// fetchIncompletePayProfiles — Roster v2 phase 3 test.
//
// The branching logic here is the bit that bites: FTE needs
// EITHER salary OR hourly rate AND contracted hours; contractor
// needs hourly rate. Wrong logic = silently zero-costed shifts
// in the phase 4 panel.

import { describe, it, expect, vi } from 'vitest'
import { fetchIncompletePayProfiles, fetchPendingRosterApprovalsCount, paginatedSumCents, fetchAdsSummary, fetchStudioDashboardData, fetchPersonalDashboardData, fetchUnstaffedBlocksThisWeek, fetchTodayOps } from './dashboard-data'

function mockSupabaseFor(rows) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }),
  }
}

const wrap = (...profiles) => profiles.map(p => ({ profiles: p }))

describe('fetchIncompletePayProfiles', () => {
  it('returns empty when no locations are passed', async () => {
    const supabase = { from: vi.fn() }
    const res = await fetchIncompletePayProfiles(supabase, [])
    expect(res).toEqual({ success: true, data: { count: 0, sample: [] } })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('skips inactive profiles', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Inactive Ian', active: false, employment_type: 'fte', annual_salary: null, hourly_rate: null, contracted_hours_per_week: null }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(0)
  })

  it('flags FTE missing both salary and hourly_rate', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Sarah FTE', active: true, employment_type: 'fte', annual_salary: null, hourly_rate: null, contracted_hours_per_week: 40 }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(1)
    expect(res.data.sample[0].name).toBe('Sarah FTE')
  })

  it('flags FTE missing contracted hours', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Aoife FTE', active: true, employment_type: 'fte', annual_salary: 50000, hourly_rate: null, contracted_hours_per_week: 0 }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(1)
  })

  it('does NOT flag complete FTE (salary + hours)', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Brian FTE', active: true, employment_type: 'fte', annual_salary: 45000, hourly_rate: null, contracted_hours_per_week: 30 }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(0)
  })

  it('does NOT flag FTE with hourly rate + hours (no salary)', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Cara FTE', active: true, employment_type: 'fte', annual_salary: null, hourly_rate: 22, contracted_hours_per_week: 25 }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(0)
  })

  it('flags contractor missing hourly_rate', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Dan Contractor', active: true, employment_type: 'contractor', annual_salary: null, hourly_rate: null, contracted_hours_per_week: null }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(1)
  })

  it('does NOT flag contractor with hourly_rate set (hours irrelevant)', async () => {
    const supabase = mockSupabaseFor(wrap(
      { id: '1', full_name: 'Eve Contractor', active: true, employment_type: 'contractor', annual_salary: null, hourly_rate: 35, contracted_hours_per_week: null }
    ))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(0)
  })

  it('dedupes a profile assigned to multiple locations', async () => {
    const incomplete = { id: '1', full_name: 'Frank Multi', active: true, employment_type: 'contractor', hourly_rate: null, annual_salary: null, contracted_hours_per_week: null }
    const supabase = mockSupabaseFor(wrap(incomplete, incomplete, incomplete))
    const res = await fetchIncompletePayProfiles(supabase, ['loc1', 'loc2', 'loc3'])
    expect(res.data.count).toBe(1)
    expect(res.data.sample).toHaveLength(1)
  })

  it('truncates the sample at 20 names', async () => {
    const many = []
    for (let i = 0; i < 30; i++) {
      many.push({ profiles: { id: `${i}`, full_name: `Coach ${i}`, active: true, employment_type: 'contractor', hourly_rate: null } })
    }
    const supabase = mockSupabaseFor(many)
    const res = await fetchIncompletePayProfiles(supabase, ['loc1'])
    expect(res.data.count).toBe(30)
    expect(res.data.sample).toHaveLength(20)
  })
})

describe('fetchPendingRosterApprovalsCount', () => {
  function mockCountResult(count, error = null) {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ count, error }),
          }),
        }),
      }),
    }
  }

  it('returns zero count when ownerLocationIds is empty (does not query)', async () => {
    const supabase = { from: vi.fn() }
    const res = await fetchPendingRosterApprovalsCount(supabase, [])
    expect(res).toEqual({ success: true, data: { count: 0 } })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns the supabase count when called with locations', async () => {
    const supabase = mockCountResult(3)
    const res = await fetchPendingRosterApprovalsCount(supabase, ['loc1', 'loc2'])
    expect(res).toEqual({ success: true, data: { count: 3 } })
  })

  it('treats null count as zero (Supabase head:true returns null when no rows)', async () => {
    const supabase = mockCountResult(null)
    const res = await fetchPendingRosterApprovalsCount(supabase, ['loc1'])
    expect(res.data.count).toBe(0)
  })

  it('surfaces the error when supabase returns one', async () => {
    const supabase = mockCountResult(0, { message: 'permission denied' })
    const res = await fetchPendingRosterApprovalsCount(supabase, ['loc1'])
    expect(res.success).toBe(false)
    expect(res.error).toBe('permission denied')
  })
})

// ---------------------------------------------------------------------------
// DASH-REBUILD.3b — chainable builder stub for the block fetchers. Every
// method records [name, ...args] and returns the builder; awaiting resolves
// the canned response (a function response receives the recorded calls, so
// pagination mocks can slice by the .range() args).

function chainableBuilder(response) {
  const calls = []
  const b = { calls }
  for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lte', 'is', 'not', 'in', 'order', 'range', 'limit']) {
    b[m] = (...args) => { calls.push([m, ...args]); return b }
  }
  b.then = (resolve, reject) => Promise.resolve()
    .then(() => (typeof response === 'function' ? response(calls) : response))
    .then(resolve, reject)
  return b
}

describe('paginatedSumCents', () => {
  // Mock backed by a rows array: each page is served by slicing on the
  // .range(from, to) args, exactly like PostgREST's 1000-row cap would.
  function pagingSupabase(rows) {
    return {
      from: vi.fn(() => chainableBuilder(calls => {
        const range = calls.find(c => c[0] === 'range')
        const [, from, to] = range
        return { data: rows.slice(from, to + 1), error: null }
      })),
    }
  }

  it('exactly 1000 rows: sum is exact and the loop terminates (boundary page + empty follow-up)', async () => {
    const rows = Array.from({ length: 1000 }, () => ({ amount_cents: 2 }))
    const supabase = pagingSupabase(rows)
    const res = await paginatedSumCents(supabase, q => q)
    expect(res).toEqual({ totalCents: 2000, rows: 1000 })
    // A full page can't prove it was the last — one empty follow-up fetch.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('1001 rows: paginates onto a second page and sums both', async () => {
    const rows = Array.from({ length: 1001 }, () => ({ amount_cents: 3 }))
    const supabase = pagingSupabase(rows)
    const res = await paginatedSumCents(supabase, q => q)
    expect(res).toEqual({ totalCents: 3003, rows: 1001 })
    // Second page is short (1 < 1000) so the loop stops there.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('under a page (999 rows): single fetch, no follow-up', async () => {
    const rows = Array.from({ length: 999 }, () => ({ amount_cents: 1 }))
    const supabase = pagingSupabase(rows)
    const res = await paginatedSumCents(supabase, q => q)
    expect(res).toEqual({ totalCents: 999, rows: 999 })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('surfaces a query error without throwing', async () => {
    const supabase = { from: vi.fn(() => chainableBuilder({ data: null, error: { message: 'boom' } })) }
    const res = await paginatedSumCents(supabase, q => q)
    expect(res.error).toEqual({ message: 'boom' })
  })
})

describe('fetchAdsSummary', () => {
  function adsSupabase({ adsRows, attributedCount = 0 }) {
    const builders = { ad_insights_daily: [], contacts: [] }
    return {
      builders,
      from: vi.fn(table => {
        const b = table === 'ad_insights_daily'
          ? chainableBuilder({ data: adsRows, error: null })
          : chainableBuilder({ count: attributedCount, error: null })
        builders[table].push(b)
        return b
      }),
    }
  }

  it("filters level='campaign' in the query itself and pages with a stable id order", async () => {
    const supabase = adsSupabase({ adsRows: [], attributedCount: 0 })
    await fetchAdsSummary(supabase, 'loc1')
    const calls = supabase.builders.ad_insights_daily[0].calls
    expect(calls).toContainEqual(['eq', 'level', 'campaign'])
    expect(calls).toContainEqual(['order', 'id', { ascending: true }])
    expect(calls).toContainEqual(['range', 0, 999])
  })

  it('paginates past the 1k-row cap and sums every page', async () => {
    // 1001 campaign rows → page 1 (1000) + page 2 (1), summed exactly.
    const adsRows = Array.from({ length: 1001 }, () => ({ level: 'campaign', spend: '1.00', results: 1 }))
    let adsFetches = 0
    const supabase = {
      from: vi.fn(table => {
        if (table !== 'ad_insights_daily') return chainableBuilder({ count: 0, error: null })
        adsFetches++
        return chainableBuilder(calls => {
          const [, from, to] = calls.find(c => c[0] === 'range')
          return { data: adsRows.slice(from, to + 1), error: null }
        })
      }),
    }
    const res = await fetchAdsSummary(supabase, 'loc1')
    expect(res.success).toBe(true)
    expect(res.data.spend).toBe(1001)
    expect(res.data.results).toBe(1001)
    expect(adsFetches).toBe(2)
  })

  it('sums campaign spend/results and computes costPerResult + attributed', async () => {
    const supabase = adsSupabase({
      adsRows: [
        { level: 'campaign', spend: '10.50', results: 3 },
        { level: 'campaign', spend: '4.50', results: 1 },
      ],
      attributedCount: 2,
    })
    const res = await fetchAdsSummary(supabase, 'loc1')
    expect(res.success).toBe(true)
    expect(res.data.spend).toBe(15)
    expect(res.data.results).toBe(4)
    expect(res.data.costPerResult).toBeCloseTo(3.75)
    expect(res.data.attributedContacts).toBe(2)
  })

  it('costPerResult is null when results = 0', async () => {
    const supabase = adsSupabase({
      adsRows: [{ level: 'campaign', spend: '20.00', results: 0 }],
    })
    const res = await fetchAdsSummary(supabase, 'loc1')
    expect(res.success).toBe(true)
    expect(res.data.spend).toBe(20)
    expect(res.data.costPerResult).toBe(null)
  })

  it('defence-in-depth: a stray non-campaign row in the response is still excluded from the sum', async () => {
    const supabase = adsSupabase({
      adsRows: [
        { level: 'campaign', spend: '5', results: 1 },
        { level: 'ad', spend: '99', results: 99 },
      ],
    })
    const res = await fetchAdsSummary(supabase, 'loc1')
    expect(res.data.spend).toBe(5)
    expect(res.data.results).toBe(1)
  })

  it('surfaces the ads query error', async () => {
    const supabase = {
      from: vi.fn(() => chainableBuilder({ data: null, error: { message: 'ads down' } })),
    }
    const res = await fetchAdsSummary(supabase, 'loc1')
    expect(res).toEqual({ success: false, error: 'ads down' })
  })
})

describe('fetchStudioDashboardData', () => {
  // `contacts` is queried twice: first the head:true "new leads this
  // week" count, then the funnel page loop. Hand out a builder per
  // from() call so the test can inspect which column each filtered on.
  function studioSupabase({ leadCount = 0, funnelRows = [] } = {}) {
    const builders = []
    let contactsCall = 0
    const supabase = {
      from: (table) => {
        let b
        if (table === 'contacts') {
          contactsCall += 1
          b = contactsCall === 1
            ? chainableBuilder({ count: leadCount, error: null })
            : chainableBuilder({ data: funnelRows, error: null })
        } else {
          b = chainableBuilder({ data: [], error: null })
        }
        b.table = table
        builders.push(b)
        return b
      },
    }
    return { supabase, builders }
  }

  it('counts new leads on joined_at, never the import-poisoned lead_created_at', async () => {
    const { supabase, builders } = studioSupabase({ leadCount: 7 })
    const res = await fetchStudioDashboardData(supabase, 'loc1')

    expect(res.success).toBe(true)
    expect(res.data.newLeadsThisWeek).toBe(7)

    const countBuilder = builders.find(b => b.table === 'contacts')
    const gte = countBuilder.calls.find(c => c[0] === 'gte')
    expect(gte[1]).toBe('joined_at')

    // lead_created_at defaults to NOW() at insert, so a bulk import
    // would spike this count — it must not appear anywhere.
    const everyArg = builders.flatMap(b => b.calls.flat())
    expect(everyArg).not.toContain('lead_created_at')
  })

  it('still shapes the funnel and total from the paged contacts scan', async () => {
    const { supabase } = studioSupabase({
      leadCount: 2,
      funnelRows: [
        { pipeline_stage_slug: 'new_lead' },
        { pipeline_stage_slug: 'new_lead' },
        { pipeline_stage_slug: 'converted' },
        { pipeline_stage_slug: null },
      ],
    })
    const res = await fetchStudioDashboardData(supabase, 'loc1')

    expect(res.data.funnel).toEqual({ new_lead: 2, converted: 1, unknown: 1 })
    expect(res.data.totalContacts).toBe(4)
  })

  it('refuses without a location', async () => {
    const res = await fetchStudioDashboardData({ from: vi.fn() }, null)
    expect(res).toEqual({ success: false, error: 'No location' })
  })
})

// ROSTER-FIX.1 (D1) — the personal Today dashboard is published-only for
// EVERYONE. A manager who also coaches sees their own drafts on the Schedule
// calendar, never here, so the rule lives in the reader rather than being
// plumbed from the two callers (web today page + mobile dashboard-api), which
// pass no role.
describe('fetchPersonalDashboardData — draft shifts (D1)', () => {
  // Thenable builder mock: every filter returns `this`, awaiting yields the
  // rows registered for that table (the repo's roster-read.test.js pattern).
  function makePersonalDb(byTable) {
    return {
      from(table) {
        const result = byTable[table] || { data: [], error: null }
        const builder = {
          select() { return this },
          eq() { return this },
          in() { return this },
          gt() { return this },
          gte() { return this },
          lte() { return this },
          order() { return this },
          then(resolve) { return Promise.resolve(result).then(resolve) },
        }
        return builder
      },
    }
  }

  const block = (rosterStatus) => ({
    block_date: '2026-06-10',
    location_id: 'loc-1',
    roster_id: rosterStatus ? 'r1' : null,
    rosters: rosterStatus ? { status: rosterStatus } : null,
    shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
    locations: { id: 'loc-1', name: 'Studio' },
  })

  it('returns published shifts only, dropping a draft-roster shift', async () => {
    const db = makePersonalDb({
      shift_assignments: {
        data: [
          { id: 'pub', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: block('published') },
          { id: 'draft', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: block('draft') },
        ],
        error: null,
      },
    })
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.success).toBe(true)
    expect(res.data.monthShifts.map((s) => s.id)).toEqual(['pub'])
  })
})

// ROSTER-FIX.1 (D2) — the unstaffed-blocks alert used to select
// `shift_assignments(count)`, and a PostgREST aggregate embed cannot be
// status-filtered, so a block whose only assignment was a cancelled tombstone
// looked staffed. That is precisely the block that needs a coach.
describe('fetchUnstaffedBlocksThisWeek — cancelled assignments', () => {
  // Thenable builder mock: every filter returns `this`, awaiting yields the
  // rows registered for that table (same pattern as the D1 tests above).
  function makeBlocksDb(rows) {
    return {
      from() {
        const builder = {
          select() { return this },
          eq() { return this },
          in() { return this },
          gt() { return this },
          gte() { return this },
          lte() { return this },
          order() { return this },
          then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve) },
        }
        return builder
      },
    }
  }

  // The mock ignores the date filters, so the fixture date is arbitrary —
  // what is under test is the assignment-status filtering, nothing else.
  const today = '2026-06-10'

  it('reports a block whose only assignment is cancelled, and not one with a live assignment', async () => {
    const db = makeBlocksDb([
      { id: 'b-tombstoned', location_id: 'loc-1', block_date: today, shift_assignments: [{ profile_id: 'coach-1', status: 'cancelled' }] },
      { id: 'b-staffed', location_id: 'loc-1', block_date: today, shift_assignments: [{ profile_id: 'coach-2', status: 'scheduled' }] },
    ])
    const res = await fetchUnstaffedBlocksThisWeek(db, ['loc-1'])
    expect(res.success).toBe(true)
    expect(res.data.count).toBe(1)
    expect(res.data.byLocation).toEqual({ 'loc-1': 1 })
  })

  it('counts a swapped shift and a legacy statusless row as staffed, and an empty block as unstaffed', async () => {
    const db = makeBlocksDb([
      { id: 'b-swapped', location_id: 'loc-1', block_date: today, shift_assignments: [{ profile_id: 'coach-1', status: 'swapped' }] },
      { id: 'b-legacy', location_id: 'loc-1', block_date: today, shift_assignments: [{ profile_id: 'coach-2' }] },
      { id: 'b-empty', location_id: 'loc-2', block_date: today, shift_assignments: [] },
    ])
    const res = await fetchUnstaffedBlocksThisWeek(db, ['loc-1', 'loc-2'])
    expect(res.data.count).toBe(1)
    expect(res.data.byLocation).toEqual({ 'loc-2': 1 })
  })
})

// ROSTER-FIX.1 — the Today strip's staffToday counted every assignment row on
// today's blocks, cancelled ones included, so an approved swap-drop still
// reported a coach as in today. Same `live` predicate as the unstaffed-blocks
// alert above (isLiveRow), which is why both now share one definition.
describe('fetchTodayOps — staffToday ignores cancelled assignments', () => {
  function makeTodayDb(blocks) {
    return {
      from(table) {
        const response = table === 'shift_blocks'
          ? { data: blocks, error: null }
          : table === 'shift_assignments'
            ? { data: [], error: null }
            : { count: 0, error: null }
        return chainableBuilder(response)
      },
    }
  }

  it('counts only live assignees, and dedupes a coach on two blocks', async () => {
    const db = makeTodayDb([
      { id: 'b1', shift_assignments: [
        { profile_id: 'coach-live', status: 'scheduled' },
        { profile_id: 'coach-dropped', status: 'cancelled' },
      ] },
      // A swapped row is a real shift owned by the taker, and a statusless
      // legacy row is live — both count. coach-live is on both blocks.
      { id: 'b2', shift_assignments: [
        { profile_id: 'coach-live', status: 'swapped' },
        { profile_id: 'coach-legacy' },
      ] },
    ])
    const res = await fetchTodayOps(db, 'loc-1')
    expect(res.success).toBe(true)
    expect(res.data.staffToday).toBe(2)
  })
})

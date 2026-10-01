// fetchIncompletePayProfiles — Roster v2 phase 3 test.
//
// The branching logic here is the bit that bites: FTE needs
// EITHER salary OR hourly rate AND contracted hours; contractor
// needs hourly rate. Wrong logic = silently zero-costed shifts
// in the phase 4 panel.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { stripComments } from '../tests/helpers/js-code.js'
import { fetchIncompletePayProfiles, fetchPendingRosterApprovalsCount, paginatedSumCents, fetchAdsSummary, fetchStudioDashboardData, fetchStudioContactCounts, fetchPersonalDashboardData, fetchTodayOps, fetchRevenueMTD, fetchFunnelCounts } from './dashboard-data'

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
  for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'in', 'order', 'range', 'limit']) {
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

describe('fetchStudioDashboardData (the phone Studio tab, the phone session)', () => {
  // CONTACTREADSCOPE.1a — never reads contacts: from mig 690 the phone's own
  // session reads contacts only while holding Contacts, and this screen is
  // gated by dashboard_studio. The contact numbers come from the route.
  it('reads only the WhatsApp unread total, never contacts', async () => {
    const tables = []
    const supabase = {
      from: (table) => {
        tables.push(table)
        return chainableBuilder({ data: [{ unread_count: 2 }, { unread_count: 3 }], error: null })
      },
    }
    const res = await fetchStudioDashboardData(supabase, 'loc1')
    expect(res).toEqual({ success: true, data: { totalUnreadWhatsapp: 5 } })
    expect(tables).toEqual(['whatsapp_conversations'])
  })

  // REVIEWNITS.1 (D5): the read's error was dropped and `(data || [])` summed
  // to 0, so a failed read showed "0 unread". Unknown is null (the phone shows
  // a dash); the tab itself still loads (success stays true: failing the
  // whole fetch would blank every other card for one count).
  it('a failed unread read is unknown (null), never 0, and does not fail the tab', async () => {
    const supabase = { from: () => chainableBuilder({ data: null, error: { message: 'down' } }) }
    const res = await fetchStudioDashboardData(supabase, 'loc1')
    expect(res).toEqual({ success: true, data: { totalUnreadWhatsapp: null } })
  })

  it('no unread conversations is a real 0', async () => {
    const supabase = { from: () => chainableBuilder({ data: [], error: null }) }
    expect(await fetchStudioDashboardData(supabase, 'loc1')).toEqual({ success: true, data: { totalUnreadWhatsapp: 0 } })
  })

  it('refuses without a location', async () => {
    const res = await fetchStudioDashboardData({ from: vi.fn() }, null)
    expect(res).toEqual({ success: false, error: 'No location' })
  })
})

describe('fetchStudioContactCounts (server, service role)', () => {
  const WEEK = '2026-09-28T00:00:00.000Z'
  // `contacts` is queried twice: the head:true "new leads this week" count,
  // then the funnel page loop. One builder per from() call.
  function studioSupabase({ leadCount = 0, leadError = null, funnelRows = [], pageError = null } = {}) {
    const builders = []
    let contactsCall = 0
    const supabase = {
      from: (table) => {
        contactsCall += 1
        const b = contactsCall === 1
          ? chainableBuilder({ count: leadCount, error: leadError })
          : chainableBuilder({ data: pageError ? null : funnelRows, error: pageError })
        b.table = table
        builders.push(b)
        return b
      },
    }
    return { supabase, builders }
  }

  it('counts new leads on joined_at since the given week start, never lead_created_at', async () => {
    const { supabase, builders } = studioSupabase({ leadCount: 7 })
    const res = await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK })
    expect(res.success).toBe(true)
    expect(res.data.newLeadsThisWeek).toBe(7)
    expect(builders.every((b) => b.table === 'contacts')).toBe(true)
    const gte = builders[0].calls.find((c) => c[0] === 'gte')
    expect(gte).toEqual(['gte', 'joined_at', WEEK])
    expect(builders.flatMap((b) => b.calls.flat())).not.toContain('lead_created_at')
  })

  it('scopes every read to the one studio', async () => {
    const { supabase, builders } = studioSupabase({ leadCount: 1, funnelRows: [{ pipeline_stage_slug: 'new_lead' }] })
    await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK })
    expect(builders.length).toBe(2)
    for (const b of builders) expect(b.calls).toContainEqual(['eq', 'location_id', 'loc1'])
  })

  it('shapes the funnel and the total from the paged scan', async () => {
    const { supabase } = studioSupabase({
      leadCount: 2,
      funnelRows: [
        { pipeline_stage_slug: 'new_lead' }, { pipeline_stage_slug: 'new_lead' },
        { pipeline_stage_slug: 'converted' }, { pipeline_stage_slug: null },
      ],
    })
    const res = await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK })
    expect(res.data.funnel).toEqual({ new_lead: 2, converted: 1, unknown: 1 })
    expect(res.data.totalContacts).toBe(4)
  })

  it('pages past the 1000-row cap with an explicit order', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ pipeline_stage_slug: i % 2 ? 'new_lead' : 'converted' }))
    const builders = []
    let n = 0
    const supabase = {
      from: () => {
        n += 1
        const b = n === 1
          ? chainableBuilder({ count: 0, error: null })
          : chainableBuilder((calls) => {
            const r = calls.find((c) => c[0] === 'range')
            return { data: rows.slice(r[1], r[2] + 1), error: null }
          })
        builders.push(b)
        return b
      },
    }
    const res = await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK })
    expect(res.data.totalContacts).toBe(2500)
    expect(res.data.funnel).toEqual({ new_lead: 1250, converted: 1250 })
    expect(builders.slice(1).every((b) => b.calls.some((c) => c[0] === 'order' && c[1] === 'id'))).toBe(true)
  })

  it('a failed count is a failure, never a zero', async () => {
    const { supabase } = studioSupabase({ leadError: { message: 'count down' } })
    expect(await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK }))
      .toEqual({ success: false, error: 'count down' })
  })

  it('a failed page is a failure, never a partial funnel', async () => {
    const { supabase } = studioSupabase({ leadCount: 1, pageError: { message: 'page down' } })
    expect(await fetchStudioContactCounts(supabase, 'loc1', { weekStartIso: WEEK }))
      .toEqual({ success: false, error: 'page down' })
  })

  it('refuses without a location or a week start', async () => {
    expect(await fetchStudioContactCounts({ from: vi.fn() }, null, { weekStartIso: WEEK }))
      .toEqual({ success: false, error: 'No location' })
    expect(await fetchStudioContactCounts({ from: vi.fn() }, 'loc1', {}))
      .toEqual({ success: false, error: 'No week start' })
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

  // BLOCKEDIT.1 — Today (web) and the phone's personal dashboard read the
  // coach's own shifts here; each row carries its shift's briefing.
  it("asks for the block's briefing and carries it on each row", async () => {
    const selects = []
    const base = makePersonalDb({
      shift_assignments: {
        data: [{ id: 'pub', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: { ...block('published'), briefing: 'Fire drill at 10' } }],
        error: null,
      },
    })
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(selects.find(([t]) => t === 'shift_assignments')[1]).toMatch(/shift_blocks!inner \( [^)]*\bbriefing\b/)
    expect(res.data.monthShifts[0].briefing).toBe('Fire drill at 10')
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

  // ROSTER-SUPERSEDE.1 — same derivation as src/lib/roster-read.js: a block
  // on a superseded roster reads as unpublished. Unreachable by construction
  // (a roster is superseded only once it owns zero blocks) and pinned anyway,
  // because this is the query behind every coach's Today screen.
  it('drops a shift whose roster was SUPERSEDED', async () => {
    const db = makePersonalDb({
      shift_assignments: {
        data: [
          { id: 'pub', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: block('published') },
          { id: 'gone', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: block('superseded') },
        ],
        error: null,
      },
    })
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.data.monthShifts.map((s) => s.id)).toEqual(['pub'])
  })

  // MOBILESCHED.2 — the block's own times ride along, and display/sort/total
  // at them rather than at the template's.
  it('carries the block times and totals hours at them, not the template', async () => {
    const moved = { ...block('published'), start_time: '07:00:00', end_time: '12:00:00', shift_templates: { name: 'AM', start_time: '06:00:00', end_time: '14:00:00' } }
    const db = makePersonalDb({
      shift_assignments: {
        data: [{ id: 'm', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: moved }],
        error: null,
      },
    })
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.data.monthShifts[0]).toMatchObject({ block_start_time: '07:00:00', block_end_time: '12:00:00' })
    expect(res.data.hoursThisMonth).toBe(5)
  })

  // CANDIDATES.1 — the "Ask a coach to cover" picker ranks colleagues for the
  // shift's BLOCK; the row's `id` is the assignment id, so the block id rides
  // along too, and the select asks for it.
  it('carries the block id, and asks for it', async () => {
    const selects = []
    const withId = { ...block('published'), id: 'blk-1' }
    const base = makePersonalDb({
      shift_assignments: {
        data: [{ id: 'a1', profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', shift_blocks: withId }],
        error: null,
      },
    })
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.data.monthShifts[0]).toMatchObject({ id: 'a1', block_id: 'blk-1' })
    expect(selects.find(([t]) => t === 'shift_assignments')[1]).toMatch(/shift_blocks!inner \( id, block_date/)
  })

  // MOBILESCHED.2 — the swaps-targeting-me read fed a key (pendingSwapsForMe)
  // no surface rendered; the mobile Today card gets that list from
  // /api/schedule/swaps?for_me=1. It must stay gone, not come back on a merge.
  it('reads posted swaps only, and returns no pendingSwapsForMe', async () => {
    const tables = []
    const selects = []
    const base = makePersonalDb({})
    const db = {
      from(table) {
        tables.push(table)
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    const res = await fetchPersonalDashboardData(db, 'p1')
    expect(res.success).toBe(true)
    expect(tables.filter((t) => t === 'shift_swap_requests')).toHaveLength(1)
    expect(selects.find(([t]) => t === 'shift_swap_requests')[1]).not.toMatch(/requester_id,/)
    expect(res.data).not.toHaveProperty('pendingSwapsForMe')
    expect(res.data).toHaveProperty('myPostedSwaps')
  })

  // COVERLOOP.2 — "Swap posted" printed a raw ISO date and no time because the
  // embed never asked for the block's times.
  it('asks for the posted swap\'s block times', async () => {
    const selects = []
    const base = makePersonalDb({})
    const db = {
      from(table) {
        const b = base.from(table)
        const sel = b.select
        b.select = function (cols) { selects.push([table, cols]); return sel.call(this) }
        return b
      },
    }
    await fetchPersonalDashboardData(db, 'p1')
    const swapSelect = selects.find(([t]) => t === 'shift_swap_requests')[1]
    expect(swapSelect).toContain('shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name))')
    // MOBILESCHED.2's guard still holds.
    expect(swapSelect).not.toMatch(/requester_id,/)
  })
})

// ROSTER-FIX.1 — the Today strip's staffToday counted every assignment row on
// today's blocks, cancelled ones included, so an approved swap-drop still
// reported a coach as in today. It goes through the module's one `live`
// predicate (isLiveRow), which fetchTodayOps uses for its assignment rows.
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
      { id: 'b1', roster_id: 'r1', rosters: { status: 'published' }, shift_assignments: [
        { profile_id: 'coach-live', status: 'scheduled' },
        { profile_id: 'coach-dropped', status: 'cancelled' },
      ] },
      // A swapped row is a real shift owned by the taker, and a statusless
      // legacy row is live — both count. coach-live is on both blocks.
      { id: 'b2', roster_id: 'r1', rosters: { status: 'published' }, shift_assignments: [
        { profile_id: 'coach-live', status: 'swapped' },
        { profile_id: 'coach-legacy' },
      ] },
    ])
    const res = await fetchTodayOps(db, 'loc-1')
    expect(res.success).toBe(true)
    expect(res.data.staffToday).toBe(2)
  })

  // STAFFTODAY.1 — only a published roster puts a coach in today.
  it('leaves out coaches on draft, superseded and unrostered blocks', async () => {
    const db = makeTodayDb([
      { id: 'pub', roster_id: 'r1', rosters: { status: 'published' }, shift_assignments: [{ profile_id: 'coach-in', status: 'scheduled' }] },
      { id: 'draft', roster_id: 'r2', rosters: { status: 'draft' }, shift_assignments: [{ profile_id: 'coach-draft', status: 'scheduled' }] },
      { id: 'old', roster_id: 'r3', rosters: { status: 'superseded' }, shift_assignments: [{ profile_id: 'coach-old', status: 'scheduled' }] },
      { id: 'loose', roster_id: null, rosters: null, shift_assignments: [{ profile_id: 'coach-loose', status: 'scheduled' }] },
    ])
    const res = await fetchTodayOps(db, 'loc-1')
    expect(res.success).toBe(true)
    expect(res.data.staffToday).toBe(1)
  })
})

// LABOURWEEK.1 — "labour this week" (Business dashboard + phone Business tab)
// summed every assignment in the week window: cancelled rows (swap-drops,
// removed coaches) and draft rosters included. It now costs live rows on
// published rosters only.
describe('fetchTodayOps — labour this week counts live, published shifts only', () => {
  function assignment(id, { status = 'scheduled', rosterStatus = 'published', rosterId = 'r1', rate = 20 } = {}) {
    return {
      id, profile_id: `p-${id}`, start_time_override: null, end_time_override: null, status,
      shift_blocks: {
        id: `b-${id}`, block_date: '2026-09-28', start_time: '09:00', end_time: '11:00', briefing: null,
        location_id: 'loc-1', roster_id: rosterId, rosters: rosterId ? { status: rosterStatus } : null,
        shift_templates: { name: 'Class', start_time: '09:00', end_time: '11:00' }, locations: { id: 'loc-1', name: 'S' },
      },
      profiles: { hourly_rate: rate, annual_salary: null, contracted_hours_per_week: null, employment_type: 'contractor' },
    }
  }
  function makeOpsDb(assignments) {
    return {
      from(table) {
        const response = table === 'shift_assignments'
          ? { data: assignments, error: null }
          : table === 'shift_blocks'
            ? { data: [], error: null }
            : { count: 0, error: null }
        return chainableBuilder(response)
      },
    }
  }

  it('costs a live shift on a published roster (2h at 20/h = 4000 cents)', async () => {
    const res = await fetchTodayOps(makeOpsDb([assignment('a')]), 'loc-1')
    expect(res.success).toBe(true)
    expect(res.data.labourWeekCents).toBe(4000)
    expect(res.data.hoursWeek).toBe(2)
  })

  it('leaves out cancelled rows, draft rosters and blocks on no roster', async () => {
    const res = await fetchTodayOps(makeOpsDb([
      assignment('live'),
      assignment('dropped', { status: 'cancelled' }),
      assignment('draft', { rosterStatus: 'draft' }),
      assignment('superseded', { rosterStatus: 'superseded' }),
      assignment('unrostered', { rosterId: null }),
    ]), 'loc-1')
    expect(res.data.labourWeekCents).toBe(4000)
    expect(res.data.hoursWeek).toBe(2)
  })

  it('still counts a swapped row (a real shift now owned by the taker) and a statusless legacy row', async () => {
    const res = await fetchTodayOps(makeOpsDb([
      assignment('swapped', { status: 'swapped' }),
      assignment('legacy', { status: null }),
    ]), 'loc-1')
    expect(res.data.labourWeekCents).toBe(8000)
    expect(res.data.hoursWeek).toBe(4)
  })
})

// DUBLINDAY.1 — the Today strip's "today" and "this week" are Dublin calendar
// days. They were the server's local days, and the server runs in UTC, so
// from 00:00 to 01:00 Dublin in summer the strip read yesterday.
describe('fetchTodayOps — today and this week are Dublin days', () => {
  function recordingDb() {
    const builders = {}
    return {
      builders,
      from(table) {
        const response = table === 'shift_blocks' || table === 'shift_assignments'
          ? { data: [], error: null }
          : { count: 0, error: null }
        const b = chainableBuilder(response)
        ;(builders[table] ||= []).push(b)
        return b
      },
    }
  }
  const arg = (b, method, col) => b.calls.find((c) => c[0] === method && c[1] === col)?.[2]

  it('00:30 Dublin on Monday 28 Sep 2026 (23:30 UTC Sunday) is Monday, in a Monday week', async () => {
    const db = recordingDb()
    const res = await fetchTodayOps(db, 'loc-1', new Date('2026-09-27T23:30:00Z'))
    expect(res.success).toBe(true)
    expect(arg(db.builders.bookings[0], 'eq', 'booking_date')).toBe('2026-09-28')
    expect(arg(db.builders.shift_blocks[0], 'eq', 'block_date')).toBe('2026-09-28')
    // Irish summer time: Dublin midnight is 23:00 UTC the day before.
    expect(arg(db.builders.class_occurrences[0], 'gte', 'starts_at')).toBe('2026-09-27T23:00:00.000Z')
    expect(arg(db.builders.class_occurrences[0], 'lt', 'starts_at')).toBe('2026-09-28T23:00:00.000Z')
    const shifts = db.builders.shift_assignments[0]
    expect(arg(shifts, 'gte', 'shift_blocks.block_date')).toBe('2026-09-28')
    expect(arg(shifts, 'lte', 'shift_blocks.block_date')).toBe('2026-10-04')
  })

  it('23:30 Dublin on Sunday 4 Oct 2026 is still Sunday, in the week that began Monday 28 Sep', async () => {
    const db = recordingDb()
    await fetchTodayOps(db, 'loc-1', new Date('2026-10-04T22:30:00Z'))
    expect(arg(db.builders.bookings[0], 'eq', 'booking_date')).toBe('2026-10-04')
    const shifts = db.builders.shift_assignments[0]
    expect(arg(shifts, 'gte', 'shift_blocks.block_date')).toBe('2026-09-28')
    expect(arg(shifts, 'lte', 'shift_blocks.block_date')).toBe('2026-10-04')
  })

  it('the clocks-back day (25 Oct 2026) is a 25-hour window from 23:00 UTC to 00:00 UTC', async () => {
    const db = recordingDb()
    await fetchTodayOps(db, 'loc-1', new Date('2026-10-25T12:00:00Z'))
    expect(arg(db.builders.class_occurrences[0], 'gte', 'starts_at')).toBe('2026-10-24T23:00:00.000Z')
    expect(arg(db.builders.class_occurrences[0], 'lt', 'starts_at')).toBe('2026-10-26T00:00:00.000Z')
  })

  it('in winter (GMT) Dublin midnight is UTC midnight', async () => {
    const db = recordingDb()
    await fetchTodayOps(db, 'loc-1', new Date('2026-12-01T00:30:00Z'))
    expect(arg(db.builders.bookings[0], 'eq', 'booking_date')).toBe('2026-12-01')
    expect(arg(db.builders.class_occurrences[0], 'gte', 'starts_at')).toBe('2026-12-01T00:00:00.000Z')
    expect(arg(db.builders.class_occurrences[0], 'lt', 'starts_at')).toBe('2026-12-02T00:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// A4 REVENUEMTD.1 — the Business dashboard's windows are Europe/Dublin days.
// They were the server's local days (UTC on Vercel).

// A stub that APPLIES the recorded filters, so a test can say which payments
// land in which month, not only which strings were sent: eq on a column,
// gte/gt/lt/lte on an instant, then the .range() page.
function filteringDb(rows) {
  const builders = []
  const cmp = { gte: (a, b) => a >= b, gt: (a, b) => a > b, lt: (a, b) => a < b, lte: (a, b) => a <= b }
  return {
    builders,
    from(table) {
      const b = chainableBuilder((calls) => {
        let out = rows
        for (const [m, col, v] of calls) {
          if (m === 'eq') out = out.filter((r) => r[col] === v)
          else if (cmp[m]) out = out.filter((r) => cmp[m](Date.parse(r[col]), Date.parse(v)))
        }
        const range = calls.find((c) => c[0] === 'range')
        return { data: range ? out.slice(range[1], range[2] + 1) : out, error: null }
      })
      b.table = table
      builders.push(b)
      return b
    },
  }
}
const paid = (invoice_date, amount_cents) => ({ location_id: 'loc-1', status: 'PAID', invoice_date, amount_cents })
const callArg = (b, method, col) => b.calls.find((c) => c[0] === method && c[1] === col)?.[2]

describe('fetchRevenueMTD — the month is a Dublin month (A4 REVENUEMTD.1)', () => {
  it('a payment at 00:30 Dublin on 1 Oct 2026 (23:30 UTC on 30 Sep) counts in October', async () => {
    const db = filteringDb([
      paid('2026-09-30T23:30:00Z', 5000), // 00:30 Dublin, 1 Oct: October
      paid('2026-09-30T22:30:00Z', 7000), // 23:30 Dublin, 30 Sep: September, and past last month's 1-day window
      paid('2026-09-01T10:00:00Z', 4000), // 1 Sep: last month's same-day window
    ])
    const res = await fetchRevenueMTD(db, 'loc-1', new Date('2026-10-01T10:00:00Z'))
    expect(res.success).toBe(true)
    expect(res.data.totalCents).toBe(5000)
    expect(res.data.paidCount).toBe(1)
    expect(res.data.deltaPct).toBe(25) // 5000 vs 4000
  })

  it('in the first Dublin hour of the 1st, MTD is the new month, not the whole of the last one', async () => {
    const db = filteringDb([
      paid('2026-09-15T12:00:00Z', 9000), // September
      paid('2026-09-30T23:10:00Z', 5000), // 00:10 Dublin, 1 Oct
    ])
    const res = await fetchRevenueMTD(db, 'loc-1', new Date('2026-09-30T23:30:00Z')) // 00:30 Dublin, 1 Oct
    expect(res.data.totalCents).toBe(5000)
    expect(res.data.paidCount).toBe(1)
  })

  it('asks for half-open Dublin windows: [1st 00:00, …) and [last month 1st, the day after the same day)', async () => {
    const db = filteringDb([])
    await fetchRevenueMTD(db, 'loc-1', new Date('2026-09-30T23:30:00Z'))
    const [cur, prev] = db.builders
    // Irish summer time: Dublin midnight is 23:00 UTC the day before.
    expect(callArg(cur, 'gte', 'invoice_date')).toBe('2026-09-30T23:00:00.000Z')
    expect(cur.calls.some((c) => c[0] === 'lt' || c[0] === 'lte')).toBe(false)
    expect(callArg(prev, 'gte', 'invoice_date')).toBe('2026-08-31T23:00:00.000Z')
    expect(callArg(prev, 'lt', 'invoice_date')).toBe('2026-09-01T23:00:00.000Z')
    expect(prev.calls.some((c) => c[0] === 'lte')).toBe(false)
  })

  it("last month's comparison across the 25 Oct clock change: 1 Oct 00:00 IST to 26 Oct 00:00 GMT", async () => {
    const db = filteringDb([
      paid('2026-09-30T22:30:00Z', 8000), // 23:30 Dublin, 30 Sep: September, out
      paid('2026-09-30T23:30:00Z', 1000), // 00:30 Dublin, 1 Oct (IST): in
      paid('2026-10-25T23:30:00Z', 2000), // 23:30 Dublin, 25 Oct (GMT, after the change): in
      paid('2026-10-26T00:30:00Z', 4000), // 26 Oct: past the same day, out
      paid('2026-11-01T00:30:00Z', 3000), // November
    ])
    const res = await fetchRevenueMTD(db, 'loc-1', new Date('2026-11-25T12:00:00Z'))
    const [cur, prev] = db.builders
    expect(callArg(cur, 'gte', 'invoice_date')).toBe('2026-11-01T00:00:00.000Z')
    expect(callArg(prev, 'gte', 'invoice_date')).toBe('2026-09-30T23:00:00.000Z')
    expect(callArg(prev, 'lt', 'invoice_date')).toBe('2026-10-26T00:00:00.000Z')
    expect(res.data.totalCents).toBe(3000)
    expect(res.data.deltaPct).toBe(0) // 3000 vs 1000 + 2000
  })

  it('on the 31st after a 30-day month, last month is all of it and never spills into this one', async () => {
    const db = filteringDb([
      paid('2026-09-15T12:00:00Z', 3000), // September
      paid('2026-10-01T10:00:00Z', 6000), // 1 Oct: this month only
    ])
    const res = await fetchRevenueMTD(db, 'loc-1', new Date('2026-10-31T12:00:00Z'))
    expect(res.data.totalCents).toBe(6000)
    expect(res.data.deltaPct).toBe(100) // 6000 vs 3000, not vs 9000
  })

  it.each([
    ['31 Oct: all of September', '2026-10-31T12:00:00Z', '2026-08-31T23:00:00.000Z', '2026-09-30T23:00:00.000Z'],
    ['31 Mar: all of February', '2026-03-31T12:00:00Z', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    ['30 Mar: all of February', '2026-03-30T12:00:00Z', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
    ['15 Jan: 1-15 Dec of the year before', '2027-01-15T12:00:00Z', '2026-12-01T00:00:00.000Z', '2026-12-16T00:00:00.000Z'],
  ])('%s', async (_label, nowIso, gte, lt) => {
    const db = filteringDb([])
    await fetchRevenueMTD(db, 'loc-1', new Date(nowIso))
    const prev = db.builders[1]
    expect(callArg(prev, 'gte', 'invoice_date')).toBe(gte)
    expect(callArg(prev, 'lt', 'invoice_date')).toBe(lt)
  })

  it('a failed read is an error, never a zero month', async () => {
    const db = { from: () => chainableBuilder({ data: null, error: { message: 'invoices down' } }) }
    const res = await fetchRevenueMTD(db, 'loc-1', new Date('2026-10-01T10:00:00Z'))
    expect(res).toEqual({ success: false, error: 'invoices down' })
  })
})

describe('fetchFunnelCounts — "this month" is a Dublin month (A4 REVENUEMTD.1)', () => {
  function countingDb() {
    const builders = []
    return {
      builders,
      from(table) {
        const b = chainableBuilder({ count: 0, error: null })
        b.table = table
        builders.push(b)
        return b
      },
    }
  }
  const monthStarts = (db, col) =>
    db.builders.map((b) => callArg(b, 'gte', col)).filter(Boolean)

  it('00:30 Dublin on 1 Oct 2026 counts from 1 Oct 00:00 Dublin (23:00 UTC)', async () => {
    const db = countingDb()
    const res = await fetchFunnelCounts(db, 'loc-1', new Date('2026-09-30T23:30:00Z'))
    expect(res.success).toBe(true)
    expect(monthStarts(db, 'joined_at')).toEqual(['2026-09-30T23:00:00.000Z'])
    expect(monthStarts(db, 'converted_at')).toEqual(['2026-09-30T23:00:00.000Z'])
  })

  it('in winter (GMT) the Dublin month starts at UTC midnight', async () => {
    const db = countingDb()
    await fetchFunnelCounts(db, 'loc-1', new Date('2026-12-01T00:30:00Z'))
    expect(monthStarts(db, 'joined_at')).toEqual(['2026-12-01T00:00:00.000Z'])
    expect(monthStarts(db, 'converted_at')).toEqual(['2026-12-01T00:00:00.000Z'])
  })
})

describe('fetchAdsSummary — the last 7 days are Dublin days (A4 REVENUEMTD.1)', () => {
  function adsDb() {
    const builders = { ad_insights_daily: [], contacts: [] }
    return {
      builders,
      from(table) {
        const b = table === 'ad_insights_daily'
          ? chainableBuilder({ data: [], error: null })
          : chainableBuilder({ count: 0, error: null })
        builders[table].push(b)
        return b
      },
    }
  }

  it('00:30 Dublin on 1 Oct 2026: spend from 24 Sep (Dublin), leads from exactly 7 x 24 h ago', async () => {
    const db = adsDb()
    const res = await fetchAdsSummary(db, 'loc-1', new Date('2026-09-30T23:30:00Z'))
    expect(res.success).toBe(true)
    expect(callArg(db.builders.ad_insights_daily[0], 'gte', 'date')).toBe('2026-09-24')
    expect(callArg(db.builders.contacts[0], 'gte', 'attributed_at')).toBe('2026-09-23T23:30:00.000Z')
  })

  it('a week across the 25 Oct clock change is still 7 x 24 h for leads', async () => {
    const db = adsDb()
    await fetchAdsSummary(db, 'loc-1', new Date('2026-10-31T12:00:00Z'))
    expect(callArg(db.builders.ad_insights_daily[0], 'gte', 'date')).toBe('2026-10-24')
    expect(callArg(db.builders.contacts[0], 'gte', 'attributed_at')).toBe('2026-10-24T12:00:00.000Z')
  })
})

describe("fetchPersonalDashboardData — the weeks hang off the caller's today (A4 REVENUEMTD.1)", () => {
  function recordingDb() {
    const builders = []
    return {
      builders,
      from(table) {
        const b = chainableBuilder({ data: [], error: null })
        b.table = table
        builders.push(b)
        return b
      },
    }
  }
  const WEEKS_OF_3_MAR_2027 = {
    weekStartIso: '2027-03-01', weekEndIso: '2027-03-07',
    nextWeekStartIso: '2027-03-08', nextWeekEndIso: '2027-03-14',
    monthStartIso: '2027-03-01', monthEndIso: '2027-04-18',
  }

  it('a Dublin today from the server anchors this week, next week and the 7-week roster', async () => {
    const db = recordingDb()
    const res = await fetchPersonalDashboardData(db, 'p1', 'loc-1', { todayIso: '2027-03-07' }) // a Sunday
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject(WEEKS_OF_3_MAR_2027)
    // The two shift reads: the 14-day window, then the 7-week roster.
    const shiftReads = db.builders.filter((b) => b.table === 'shift_assignments')
    expect(shiftReads.map((b) => [
      callArg(b, 'gte', 'shift_blocks.block_date'),
      callArg(b, 'lte', 'shift_blocks.block_date'),
    ])).toEqual([['2027-03-01', '2027-03-14'], ['2027-03-01', '2027-04-18']])
  })

  // The phone passes no today. Its device day is Dublin's for staff in
  // Ireland, and reading it needs no Intl (Hermes without ICU). This pins
  // that the refactor changed nothing for it, in whatever zone the run uses.
  it("with no today (the phone), the device's calendar day is used, exactly as before", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2027, 2, 3, 12, 0, 0)) // local noon, Wednesday 3 Mar 2027
    try {
      const res = await fetchPersonalDashboardData(recordingDb(), 'p1', 'loc-1')
      expect(res.data).toMatchObject(WEEKS_OF_3_MAR_2027)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a malformed today falls back to the device day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2027, 2, 3, 12, 0, 0))
    try {
      for (const todayIso of ['3 March', '2027-3-7', '', null, 20270307, '2027-13-45', '2027-02-30']) {
        const res = await fetchPersonalDashboardData(recordingDb(), 'p1', 'loc-1', { todayIso })
        expect(res.data.weekStartIso, String(todayIso)).toBe('2027-03-01')
      }
      // A null options object (not just a null field) is also the device day.
      const nullOpts = await fetchPersonalDashboardData(recordingDb(), 'p1', 'loc-1', null)
      expect(nullOpts.data.weekStartIso).toBe('2027-03-01')
    } finally {
      vi.useRealTimers()
    }
  })
})

// A4 REVENUEMTD.1 — the staff app imports this module. Hermes without full
// ICU throws on a timeZone'd Intl.DateTimeFormat, and shared/dublin-time.js
// builds two at import, so it may only ever be loaded lazily, from the
// functions that run on the server. And those functions may never fall back to
// the local calendar, which on the server is UTC's.
describe('dashboard-data stays loadable on the phone, and the server reads Dublin (A4 REVENUEMTD.1)', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, './dashboard-data.js'), 'utf8')
  // Comments name the old helpers on purpose; they are blanked by the
  // TypeScript parser's ranges, never a regex (GUARDSTRIP.1).
  const code = stripComments(source)
  const body = (name) => {
    const start = code.indexOf(`export async function ${name}(`)
    const next = code.indexOf('\nexport ', start + 1)
    return start === -1 ? '' : code.slice(start, next === -1 ? undefined : next)
  }

  it('never imports dublin-time at module scope', () => {
    expect(code).not.toMatch(/^\s*import\s[^\n]*dublin-time/m)
    expect(code).not.toMatch(/^\s*export\s[^\n]*from\s+['"][^'"]*dublin-time/m)
    // Catches a multi-line `import {\n …\n} from './dublin-time.js'` too.
    expect(code).not.toMatch(/from\s+['"][^'"]*dublin-time/)
    expect(code).not.toMatch(/new Intl\.DateTimeFormat/)
    expect(code).toMatch(/import\(\s*['"]\.\/dublin-time\.js['"]\s*\)/)
  })

  it.each(['fetchTodayOps', 'fetchRevenueMTD', 'fetchFunnelCounts', 'fetchAdsSummary'])(
    '%s (server-run) builds no window from the local calendar',
    (name) => {
      const b = body(name)
      expect(b.length, `${name} not found`).toBeGreaterThan(50)
      expect(b).toMatch(/loadDublinTime\(\)/)
      expect(b).not.toMatch(/\b(startOfMonth|startOfWeek|endOfWeek|isoDate)\(/)
      expect(b).not.toMatch(/\.(setHours|setDate|getDate|getDay|getMonth|getFullYear)\(/)
    },
  )

  it('imports and runs the phone-run fetchers when a timeZone formatter throws (Hermes without ICU)', async () => {
    // A `function`, not an arrow: vitest warns on an arrow-bodied constructor
    // mock (the mobile/lib/dates.test.js ROSTER-FIX.7f pattern).
    const intlSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
      throw new Error('no icu')
    })
    try {
      vi.resetModules()
      const fresh = await import('./dashboard-data.js')
      const db = { from: () => chainableBuilder({ data: [], count: 0, error: null }) }
      const personal = await fresh.fetchPersonalDashboardData(db, 'p1', 'loc-1')
      expect(personal.success).toBe(true)
      const studio = await fresh.fetchStudioDashboardData(db, 'loc-1')
      expect(studio.success).toBe(true)
    } finally {
      intlSpy.mockRestore()
      vi.resetModules()
    }
  })
})

// fetchIncompletePayProfiles — Roster v2 phase 3 test.
//
// The branching logic here is the bit that bites: FTE needs
// EITHER salary OR hourly rate AND contracted hours; contractor
// needs hourly rate. Wrong logic = silently zero-costed shifts
// in the phase 4 panel.

import { describe, it, expect, vi } from 'vitest'
import { fetchIncompletePayProfiles, fetchPendingRosterApprovalsCount, paginatedSumCents, fetchAdsSummary } from './dashboard-data'

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
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'is', 'not', 'in', 'order', 'range', 'limit']) {
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

  it("filters level='campaign' in the query itself and orders by date", async () => {
    const supabase = adsSupabase({ adsRows: [], attributedCount: 0 })
    await fetchAdsSummary(supabase, 'loc1')
    const calls = supabase.builders.ad_insights_daily[0].calls
    expect(calls).toContainEqual(['eq', 'level', 'campaign'])
    expect(calls).toContainEqual(['order', 'date', { ascending: true }])
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

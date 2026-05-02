// fetchIncompletePayProfiles — Roster v2 phase 3 test.
//
// The branching logic here is the bit that bites: FTE needs
// EITHER salary OR hourly rate AND contracted hours; contractor
// needs hourly rate. Wrong logic = silently zero-costed shifts
// in the phase 4 panel.

import { describe, it, expect, vi } from 'vitest'
import { fetchIncompletePayProfiles } from './dashboard-data'

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

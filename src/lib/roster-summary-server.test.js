// SHIFTTYPE.1 — the contractor-spend panel's server read carries each block's
// template kind, so the panel and the publish gate price the same shifts.
import { describe, it, expect } from 'vitest'
import { computeMonthlyContractorSpend } from './roster-summary-server'

function fakeDb({ blocks }) {
  const selects = {}
  const answer = (data) => {
    const q = {}
    for (const m of ['eq', 'gte', 'lte', 'in']) q[m] = () => q
    // locations: .select().eq().single()
    q.single = () => Promise.resolve({ data: { id: 'loc1', monthly_contractor_budget_eur: 100 }, error: null })
    q.then = (res, rej) => Promise.resolve({ data, error: null }).then(res, rej)
    return q
  }
  return {
    selects,
    from(table) {
      return {
        select(s) {
          selects[table] = s
          if (table === 'shift_blocks') return answer(blocks)
          if (table === 'profile_locations') return answer([{ profile_id: 'dan' }])
          if (table === 'profiles') return answer([{ id: 'dan', full_name: 'Dan', active: true, employment_type: 'contractor', hourly_rate: 35 }])
          return answer(null)
        },
      }
    },
  }
}

const blk = (id, date, start, end, kind) => ({
  id, location_id: 'loc1', template_id: 't', block_date: date, start_time: start, end_time: end, max_coaches: 5,
  shift_templates: { start_time: start, end_time: end, kind },
  shift_assignments: [{ profile_id: 'dan', status: 'scheduled' }],
})

describe('computeMonthlyContractorSpend — SHIFTTYPE.1', () => {
  it('selects the template kind and leaves admin shifts out of the spend', async () => {
    const db = fakeDb({ blocks: [blk('c', '2026-05-04', '09:00', '11:00', 'class'), blk('a', '2026-05-05', '09:00', '13:00', 'admin')] })
    const r = await computeMonthlyContractorSpend({ db, locationId: 'loc1', referenceDate: '2026-05-15' })
    expect(db.selects.shift_blocks).toMatch(/shift_templates\(start_time, end_time, kind\)/)
    expect(r.contractorCostEur).toBe(70)
    expect(r.remainingEur).toBe(30)
  })
})

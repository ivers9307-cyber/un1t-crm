// RETIRE-SHIFTS-MIRROR.1 — tests for the new-model shift fetcher that the
// report generators use in place of the legacy public.shifts mirror.
import { describe, it, expect } from 'vitest'
import { fetchScheduledShiftRows } from './report-generator'

// Minimal thenable mock of the supabase query builder: every filter method
// returns the builder; awaiting it resolves to { data }.
function mockDb(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    then: (onFulfilled, onRejected) => Promise.resolve({ data: rows }).then(onFulfilled, onRejected),
  }
  return { from: () => builder }
}

describe('fetchScheduledShiftRows', () => {
  it('normalises new-model rows to the legacy shift shape', async () => {
    const rows = [{
      profile_id: 'p1',
      start_time_override: '09:00:00',
      end_time_override: null,
      status: 'scheduled',
      profiles: { full_name: 'Jane', role: 'staff', employment_type: 'fte' },
      shift_blocks: {
        block_date: '2026-06-06',
        location_id: 'loc1',
        shift_templates: { name: 'AM', start_time: '09:30:00', end_time: '10:30:00' },
      },
    }]
    const out = await fetchScheduledShiftRows(mockDb(rows), {
      locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-30',
    })
    expect(out).toEqual([{
      shift_date: '2026-06-06',
      profile_id: 'p1',
      start_time_override: '09:00:00',
      end_time_override: null,
      status: 'scheduled',
      profiles: { full_name: 'Jane', role: 'staff', employment_type: 'fte' },
      shift_templates: { name: 'AM', start_time: '09:30:00', end_time: '10:30:00' },
    }])
  })

  it('maps block_date → shift_date and surfaces template through the block', async () => {
    const rows = [{
      profile_id: 'p2', start_time_override: null, end_time_override: null, status: 'confirmed',
      profiles: { full_name: 'Sam' },
      shift_blocks: { block_date: '2026-06-07', location_id: 'loc1', shift_templates: { name: 'PM', start_time: '17:00:00', end_time: '18:00:00' } },
    }]
    const [row] = await fetchScheduledShiftRows(mockDb(rows), { locationId: 'loc1', periodStart: '2026-06-01', periodEnd: '2026-06-30' })
    expect(row.shift_date).toBe('2026-06-07')
    expect(row.shift_templates.start_time).toBe('17:00:00')
  })

  it('returns [] for empty / null data', async () => {
    expect(await fetchScheduledShiftRows(mockDb([]), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })).toEqual([])
    expect(await fetchScheduledShiftRows(mockDb(null), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })).toEqual([])
  })

  it('tolerates a row missing its block embed (no throw)', async () => {
    const out = await fetchScheduledShiftRows(mockDb([{ profile_id: 'p3', profiles: { full_name: 'Lee' } }]), { locationId: 'x', periodStart: 'a', periodEnd: 'b' })
    expect(out[0]).toMatchObject({ profile_id: 'p3', shift_date: undefined, shift_templates: undefined })
  })
})

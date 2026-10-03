// DATECHECK.1 — the roster coverage report's days, pinned to Europe/Dublin.
//
// roster_coverage walked its period with LOCAL-midnight Dates and keyed each
// day with toISOString(), which is UTC. Under Irish summer time local midnight
// is 23:00 UTC the day before, so every key slid back a day: a Mon 4 - Sun 10
// May report ran Sun 3 - Sat 9 May and never counted a shift on the last
// Sunday, and the week the clocks go forward keyed Sun 29 Mar twice and lost
// its last day. CI and Vercel run in UTC, where the two readings agree, so only
// a file that pins the zone can see it (same reasoning, same mechanics, as
// report-generator.period.tz.test.js). The US half is
// report-generator.coverage.tz-us.test.js.
process.env.TZ = 'Europe/Dublin'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('./report-generator.js')

function coverageDb({ shifts = [], timeOff = [] } = {}) {
  const captured = {}
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, order: () => b, range: () => b,
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => Promise.resolve({
        data: table === 'shift_assignments' ? shifts : table === 'time_off_requests' ? timeOff : [],
        error: null,
      }).then(ok, err),
    }
    return b
  }
  return { db: { from }, captured }
}

function shiftOn(date) {
  return {
    profile_id: 'p1', status: 'scheduled', start_time_override: null, end_time_override: null,
    profiles: { full_name: 'Coach One', role: 'staff', employment_type: 'fte' },
    shift_blocks: {
      block_date: date, start_time: '09:00:00', end_time: '10:00:00', location_id: 'loc1',
      shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
    },
  }
}

async function coverageDays(period_start, period_end, data = {}) {
  const { db, captured } = coverageDb(data)
  createServerClient.mockReturnValue(db)
  const res = await generateReport({ report_type: 'roster_coverage', period_start, period_end, location_id: 'loc1' })
  expect(res.success).toBe(true)
  return captured.inserted.report_data.days
}

describe('roster_coverage — Europe/Dublin (BST, UTC+1)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('the host really is on Dublin time', () => {
    // Guard the guard: without this, a TZ that stopped taking effect would
    // turn the cases below into a UTC re-run that can never fail.
    expect(new Date('2026-05-15T12:00:00+01:00').getHours()).toBe(12)
  })

  it('a summer week runs Monday to Sunday, and the Sunday shift is counted', async () => {
    const days = await coverageDays('2026-05-04', '2026-05-10', { shifts: [shiftOn('2026-05-10')] })
    expect(days.map((d) => d.date)).toEqual([
      '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10',
    ])
    expect(days.find((d) => d.date === '2026-05-10').shifts_count).toBe(1)
  })

  it('the week the clocks go forward has seven different days', async () => {
    const days = await coverageDays('2026-03-27', '2026-04-02')
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02',
    ])
  })

  it('leave lands on its own days, clipped to the period', async () => {
    const days = await coverageDays('2026-05-04', '2026-05-10', {
      timeOff: [{ start_date: '2026-05-09', end_date: '2026-05-12', profile_id: 'p2', type: 'holiday', profiles: { full_name: 'Coach Two' } }],
    })
    const off = Object.fromEntries(days.map((d) => [d.date, d.staff_off]))
    expect(off['2026-05-08']).toEqual([])
    expect(off['2026-05-09']).toEqual(['Coach Two'])
    expect(off['2026-05-10']).toEqual(['Coach Two'])
  })
})

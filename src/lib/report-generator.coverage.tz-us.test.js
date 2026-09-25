// DATECHECK.1 — the US half of report-generator.coverage.tz.test.js. West of
// UTC, local midnight is the same UTC day, so the old walk happened to be right
// here; this file keeps the new one right too (CLAUDE.md: test date code under
// Europe/Dublin AND a US zone). It passes before and after the fix: it is a
// guard, not the proof. US clocks go forward on Sun 8 Mar 2026. Same zone as
// report-generator.period.tz-us.test.js.
process.env.TZ = 'America/Los_Angeles'

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('./report-generator.js')

function coverageDb({ shifts = [] } = {}) {
  const captured = {}
  const from = (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b, order: () => b, range: () => b,
      insert: (rec) => { captured.inserted = rec; return b },
      single: () => Promise.resolve({ data: { id: 'gen-1', ...captured.inserted }, error: null }),
      then: (ok, err) => Promise.resolve({ data: table === 'shift_assignments' ? shifts : [], error: null }).then(ok, err),
    }
    return b
  }
  return { db: { from }, captured }
}

async function coverageDates(period_start, period_end, data = {}) {
  const { db, captured } = coverageDb(data)
  createServerClient.mockReturnValue(db)
  const res = await generateReport({ report_type: 'roster_coverage', period_start, period_end, location_id: 'loc1' })
  expect(res.success).toBe(true)
  return captured.inserted.report_data.days
}

describe('roster_coverage — America/Los_Angeles', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('the host really is on Pacific time', () => {
    expect(new Date('2026-05-15T12:00:00-07:00').getHours()).toBe(12)
  })

  it('a summer week runs Monday to Sunday', async () => {
    const days = await coverageDates('2026-05-04', '2026-05-10')
    expect(days.map((d) => d.date)).toEqual([
      '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10',
    ])
  })

  it('the week US clocks go forward has seven different days', async () => {
    const days = await coverageDates('2026-03-05', '2026-03-11')
    expect(days.map((d) => d.date)).toEqual([
      '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11',
    ])
  })
})

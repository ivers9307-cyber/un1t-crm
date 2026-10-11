// TZ.11a — the scheduled-reports cron computes each schedule's period and next
// run in its studio's zone, read once per tick; a failed zone read runs
// nothing (next_run_at untouched, so the next tick retries).
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.example' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
// TZ.6 — this file's subject is the schedule's zone, not the daily-slot gate:
// every studio is due on every run (route.test.js / the TZ.6 tests cover the gate).
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
  ...(await importOriginal()),
  gateDailySlot: (await import('@/lib/cron-daily-slot.test-helpers')).openGate,
}))
vi.mock('@/lib/report-generator', async () => {
  const actual = await vi.importActual('@/lib/report-generator')
  return { ...actual, generateReport: vi.fn() }
})

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { generateReport } = await import('@/lib/report-generator')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { logError } = await import('@/lib/log')

const NY_LOC = 'a0000000-0000-0000-0000-0000000000a1'
const DUB_LOC = 'a0000000-0000-0000-0000-0000000000d1'

function makeDb(tables, { locationsError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      const preds = []
      let op = 'select'
      let payload
      const result = () => {
        if (table === 'locations' && locationsError) return { data: null, error: locationsError }
        if (op === 'update') { updates.push([table, payload, preds]); return { data: null, error: null } }
        return { data: (tables[table] || []).filter((r) => preds.every((p) => p(r))), error: null }
      }
      const b = {
        select() { return b },
        order() { return b },
        limit() { return b },
        not() { return b },
        lte() { return b },
        eq(col, v) { preds.push((r) => r[col] === v); return b },
        in(col, vs) { preds.push((r) => vs.includes(r[col])); return b },
        update(p) { op = 'update'; payload = p; return b },
        then(resolve) { resolve(result()) },
      }
      return b
    },
  }
}

const sched = (id, location_id) => ({
  id, location_id, report_type: 'staff_hours', report_name: 'Daily', frequency: 'daily',
  day_of_week: null, day_of_month: null, deliver_email: false, email_recipients: [], created_by: 'p-owner', active: true,
})
const cronReq = () => ({ headers: { get: (h) => (h === 'authorization' ? 'Bearer secret' : null) } })

beforeEach(() => {
  vi.clearAllMocks()
  resetLocationZoneCache()
  process.env.CRON_SECRET = 'secret'
  vi.useFakeTimers({ toFake: ['Date'] })
  generateReport.mockImplementation(async (args) => ({ success: true, data: { id: `gen-${args.scheduled_report_id}`, ...args } }))
})
afterEach(() => { vi.useRealTimers() })

describe('run-scheduled-reports — the schedule studio zone (TZ.11a)', () => {
  it('New York: yesterday and 07:00 tomorrow are New York wall clock; Dublin keeps 07:00 UTC', async () => {
    // Sun 1 Nov 2026 12:00Z = 07:00 EST (New York fell back at 06:00Z) = 12:00 GMT Dublin.
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    const db = makeDb({
      locations: [{ id: NY_LOC, timezone: 'America/New_York' }, { id: DUB_LOC, timezone: 'Europe/Dublin' }],
      scheduled_reports: [sched('s-ny', NY_LOC), sched('s-dub', DUB_LOC)],
    })
    createServerClient.mockReturnValue(db)

    const body = await (await GET(cronReq())).json()

    expect(body.success).toBe(true)
    const byId = Object.fromEntries(generateReport.mock.calls.map(([a]) => [a.scheduled_report_id, a]))
    expect(byId['s-ny']).toMatchObject({ period_start: '2026-10-31', period_end: '2026-10-31' })
    expect(byId['s-dub']).toMatchObject({ period_start: '2026-10-31', period_end: '2026-10-31' })
    const nextRun = Object.fromEntries(body.results.map((r) => [r.id, r.next_run]))
    expect(nextRun['s-ny']).toBe('2026-11-02T12:00:00.000Z') // 07:00 EST
    expect(nextRun['s-dub']).toBe('2026-11-02T07:00:00.000Z') // 07:00 UTC, as before TZ.11a
  })

  it('a failed zone read runs no schedule and leaves next_run_at alone', async () => {
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    const db = makeDb(
      { scheduled_reports: [sched('s-ny', NY_LOC)] },
      { locationsError: { message: 'connection reset' } },
    )
    createServerClient.mockReturnValue(db)

    const res = await GET(cronReq())

    expect(res.status).toBe(500)
    expect(generateReport).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
    expect(logError).toHaveBeenCalledWith('run-scheduled-reports', expect.any(String), expect.any(Object))
  })
})

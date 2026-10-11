// TZ.11a — the ad report email's date is each studio's today (it was one
// Europe/Dublin date for every studio). The zone comes from the row the cron
// already selects, so there is no read to fail.
process.env.TZ = 'America/Los_Angeles' // host zone is none of the zones under test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/ads/read', () => ({ loadAdsDashboard: vi.fn(async () => ({ kpis: {}, perAd: [] })) }))
vi.mock('@/lib/ads/report', () => ({ buildAdReportEmail: vi.fn(() => ({ subject: 's', html: 'h' })) }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn(async () => ({})) }))
// TZ.6 — this file's subject is the studio date, not the daily-slot gate: every
// studio is due on every run, in its own zone.
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({
  ...(await importOriginal()),
  gateDailySlot: (await import('@/lib/cron-daily-slot.test-helpers')).openGateZoned([
    { id: 'l-dub', timezone: 'Europe/Dublin' }, { id: 'l-ny', timezone: 'America/New_York' },
  ]),
}))

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { buildAdReportEmail } = await import('@/lib/ads/report')

const LOCS = [
  { id: 'l-dub', name: 'Dub', timezone: 'Europe/Dublin', settings: { ads: { report_recipients: ['a@example.com'] } } },
  { id: 'l-ny', name: 'NY', timezone: 'America/New_York', settings: { ads: { report_recipients: ['b@example.com'] } } },
]
function db() {
  return {
    from(table) {
      const b = {
        select: () => b, eq: () => b, limit: () => b,
        maybeSingle: async () => ({ data: { id: 'acct' }, error: null }),
        then: (resolve) => resolve({ data: table === 'locations' ? LOCS : [], error: null }),
      }
      return b
    },
  }
}
const req = { headers: { get: () => 'Bearer secret' } }
const dateFor = (name) => buildAdReportEmail.mock.calls.find(([a]) => a.locationName === name)[0].date
const legacyDublin = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date(ms))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret'
  createServerClient.mockReturnValue(db())
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => { vi.useRealTimers() })

describe('ad-report-email — the studio date (TZ.11a)', () => {
  it.each(['2026-03-29T00:59:00Z', '2026-07-01T07:00:00Z', '2026-10-25T00:30:00Z', '2026-11-01T03:30:00Z'])(
    'Europe/Dublin is the legacy en-CA Dublin date at %s; New York is its own', async (iso) => {
      vi.setSystemTime(new Date(iso))
      await GET(req)
      expect(dateFor('Dub')).toBe(legacyDublin(Date.parse(iso)))
      expect(dateFor('NY')).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso)))
    })
  it('1 Nov 03:30Z: Dublin says 1 Nov, New York 31 Oct (23:30 EDT)', async () => {
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'))
    await GET(req)
    expect(dateFor('Dub')).toBe('2026-11-01')
    expect(dateFor('NY')).toBe('2026-10-31')
  })
})

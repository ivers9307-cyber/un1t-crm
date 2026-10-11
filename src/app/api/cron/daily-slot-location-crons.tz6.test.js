// TZ.6 — the location-loop daily crons (morning-briefing, churn-radar-digest,
// ad-report-email, run-scheduled-reports, receipt-coverage-weekly) run hourly
// and act for each location only at its slot: the legacy UTC hour for a
// Europe/Dublin studio (unchanged), the target LOCAL hour elsewhere, at most
// once per local day. Bodies are mocked; what is under test is which location
// acts at which tick.
process.env.TZ = 'America/Los_Angeles'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const acted = []
const claims = new Map()
const DUB = 'loc-dub'
const NYC = 'loc-ny'

vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn(async () => ({})), sendTransactionalEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/today-feed-data', () => ({ fetchLocationTodayFeed: vi.fn(async (_db, id) => { acted.push(['morning-briefing', id]); return [] }) }))
vi.mock('@/lib/studio-pulse-data', () => ({ fetchStudioPulse: vi.fn(async () => null) }))
vi.mock('@/lib/morning-briefing', () => ({
  buildMorningBriefingEmail: vi.fn((_rows, o) => ({ subject: o.dateLabel, html: '<p/>' })),
  shapePulseMetrics: vi.fn(() => []),
}))
vi.mock('@/lib/churn-radar-data', () => ({ loadRadar: vi.fn(async (_db, id) => { acted.push(['churn-radar-digest', id]); return { summary: {} } }) }))
vi.mock('@/lib/lead-radar-data', () => ({ loadFunnel: vi.fn(async () => ({ summary: {} })) }))
vi.mock('@/lib/churn-radar-digest', () => ({ buildDigestEmail: vi.fn(() => ({ subject: 's', html: '<p/>' })) }))
vi.mock('@/lib/membership/locations-for-source', () => ({ noSourceLocationIds: vi.fn(async () => ({ ids: new Set(), error: null })) }))
vi.mock('@/lib/ads/read', () => ({ loadAdsDashboard: vi.fn(async (_db, id) => { acted.push(['ad-report-email', id]); return { kpis: {}, perAd: [] } }) }))
vi.mock('@/lib/ads/report', () => ({ buildAdReportEmail: vi.fn(({ date }) => ({ subject: date, html: '<p/>' })) }))
vi.mock('@/lib/report-generator', () => ({
  generateReport: vi.fn(async ({ location_id }) => { acted.push(['run-scheduled-reports', location_id]); return { success: false, error: 'mocked' } }),
  calculatePeriodForSchedule: vi.fn(() => ({ period_start: '2026-07-05', period_end: '2026-07-05' })),
  calculateNextRun: vi.fn(() => null),
  buildReportEmailHtml: vi.fn(() => ''),
}))
vi.mock('@/lib/recon/pull', () => ({ runCoveragePull: vi.fn(async (_db, id) => { acted.push(['receipt-coverage-weekly', id]); return { anomalies: [] } }) }))
vi.mock('@/lib/recon/statuses', () => ({ sweepSubmittedLines: vi.fn(async () => ({ flagged: 0 })), seedHunts: vi.fn(async () => ({ seeded: 0 })) }))
vi.mock('@/lib/supabase', async () => {
  const { withSlotTables } = await import('@/lib/cron-daily-slot.test-helpers')
  const TABLES = {
    locations: [
      { id: DUB, name: 'Dublin studio', churn_digest_recipients: ['ops@example.test'], settings: { ads: { report_recipients: ['ops@example.test'] } } },
      { id: NYC, name: 'New York studio', churn_digest_recipients: ['ops@example.test'], settings: { ads: { report_recipients: ['ops@example.test'] } } },
    ],
    scheduled_reports: [
      { id: 'sr-dub', location_id: DUB, active: true, frequency: 'daily', next_run_at: '2026-01-01T07:00:00Z' },
      { id: 'sr-ny', location_id: NYC, active: true, frequency: 'daily', next_run_at: '2026-01-01T07:00:00Z' },
    ],
    xero_connections: [{ location_id: DUB, location: { id: DUB, name: 'Dublin studio' } }, { location_id: NYC, location: { id: NYC, name: 'New York studio' } }],
  }
  function builder(table) {
    const b = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'not', 'lte', 'in', 'range']) b[m] = () => b
    b.maybeSingle = async () => ({ data: table === 'ad_accounts' ? { id: 'acc' } : null, error: null })
    b.then = (res, rej) => Promise.resolve({ data: TABLES[table] || [], error: null }).then(res, rej)
    return b
  }
  const zones = [{ id: DUB, timezone: 'Europe/Dublin' }, { id: NYC, timezone: 'America/New_York' }]
  return { createServerClient: () => withSlotTables({ from: builder }, { locations: zones, claims }) }
})

const ROUTES = {
  'morning-briefing': await import('./morning-briefing/route.js'),
  'churn-radar-digest': await import('./churn-radar-digest/route.js'),
  'ad-report-email': await import('./ad-report-email/route.js'),
  'run-scheduled-reports': await import('./run-scheduled-reports/route.js'),
  'receipt-coverage-weekly': await import('./receipt-coverage-weekly/route.js'),
}
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { buildMorningBriefingEmail } = await import('@/lib/morning-briefing')
const { buildAdReportEmail } = await import('@/lib/ads/report')
const req = () => new Request('https://x.test/api/cron/x', { headers: { authorization: 'Bearer shh' } })

async function ticks(cron, isos) {
  for (const iso of isos) {
    vi.setSystemTime(Date.parse(iso))
    const res = await ROUTES[cron].GET(req())
    expect(res.status, `${cron} @ ${iso}`).toBe(200)
  }
  return acted.filter(([c]) => c === cron).map(([, id]) => id)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'shh'
  acted.length = 0
  claims.clear()
})

// [cron, ticks]: an hour early, the Dublin legacy instant, a repeat inside the
// catch-up window, New York's local slot, and a repeat of that.
const CASES = [
  // Monday 6 Jul 2026 (IST / EDT)
  ['morning-briefing', ['2026-07-06T05:00:00Z', '2026-07-06T06:00:00Z', '2026-07-06T07:00:00Z', '2026-07-06T10:00:00Z', '2026-07-06T11:00:00Z']],
  ['churn-radar-digest', ['2026-07-06T06:00:00Z', '2026-07-06T07:00:00Z', '2026-07-06T08:00:00Z', '2026-07-06T11:00:00Z', '2026-07-06T12:00:00Z']],
  ['ad-report-email', ['2026-07-01T06:00:00Z', '2026-07-01T07:00:00Z', '2026-07-01T08:00:00Z', '2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']],
  ['run-scheduled-reports', ['2026-07-01T06:00:00Z', '2026-07-01T07:00:00Z', '2026-07-01T08:00:00Z', '2026-07-01T11:00:00Z', '2026-07-01T12:00:00Z']],
  // Friday 3 Jul 2026: 08:00 IST = 07:00Z (the old 07:00 UTC firing), 08:00 EDT = 12:00Z
  ['receipt-coverage-weekly', ['2026-07-03T06:00:00Z', '2026-07-03T07:00:00Z', '2026-07-03T08:00:00Z', '2026-07-03T12:00:00Z', '2026-07-03T13:00:00Z']],
]

describe('TZ.6 location-loop daily crons act once per location, at its slot', () => {
  it.each(CASES)('%s: Dublin at its legacy instant, New York at its local hour', async (cron, isos) => {
    expect(await ticks(cron, isos)).toEqual([DUB, NYC])
  })

  it('morning-briefing and churn-radar-digest do nothing on a Tuesday', async () => {
    expect(await ticks('morning-briefing', ['2026-07-07T06:00:00Z', '2026-07-07T10:00:00Z'])).toEqual([])
    expect(await ticks('churn-radar-digest', ['2026-07-07T07:00:00Z', '2026-07-07T11:00:00Z'])).toEqual([])
  })

  it('receipt-coverage-weekly in winter: 08:00 GMT is 08:00Z (the old 08:00 UTC firing), not 07:00Z', async () => {
    expect(await ticks('receipt-coverage-weekly', ['2026-12-04T07:00:00Z'])).toEqual([])
    expect(await ticks('receipt-coverage-weekly', ['2026-12-04T08:00:00Z'])).toEqual([DUB])
  })

  it('every stamping cron stamps on a quiet tick (receipt-coverage-weekly never stamps here)', async () => {
    for (const cron of ['morning-briefing', 'churn-radar-digest', 'ad-report-email', 'run-scheduled-reports', 'receipt-coverage-weekly']) {
      await ticks(cron, ['2026-07-01T03:00:00Z'])
    }
    expect(stampHeartbeat.mock.calls.map(([n]) => n).sort()).toEqual(['ad-report-email', 'churn-radar-digest', 'morning-briefing', 'run-scheduled-reports'])
  })

  it("the emailed dates are the studio's own day and label: Dublin byte-identical, New York its own", async () => {
    await ticks('morning-briefing', ['2026-07-06T06:00:00Z', '2026-07-06T10:00:00Z'])
    // The pre-TZ.6 label, verbatim, for Dublin; New York's own wall clock for New York.
    const legacy = (iso, timeZone) => new Intl.DateTimeFormat('en-IE', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(new Date(iso))
    expect(buildMorningBriefingEmail.mock.calls.map(([, o]) => o.dateLabel)).toEqual([
      legacy('2026-07-06T06:00:00Z', 'Europe/Dublin'), legacy('2026-07-06T10:00:00Z', 'America/New_York'),
    ])
    await ticks('ad-report-email', ['2026-12-31T07:00:00Z', '2027-01-01T04:00:00Z', '2026-12-31T12:00:00Z'])
    expect(buildAdReportEmail.mock.calls.map(([a]) => a.date)).toEqual(['2026-12-31', '2026-12-31'])
  })
})

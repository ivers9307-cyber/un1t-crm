// external-zones.tz.test.js — TZ.11c. Meta and Xero dictate their own zones.
//
// Meta: an insight row's `date` is a day in the AD ACCOUNT's zone
// (ad_accounts.account_timezone, Meta's `timezone_name`), so every since/until
// window asked of Meta, or read back from ad_insights_daily, is built in that
// zone; when the column is empty, in the location's zone. Xero: an org's dates
// are org-local, and one location is one Xero org, so the location's zone.
//
// America/New_York follows New York across both 2026 DST edges. The Dublin
// byte-identity sweep ran in TZ.11c and was retired in TZ.18b: Europe/Dublin is
// pinned by fixed values below, and zoned-time ≡ dublin-time stays proven by
// shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: proves nothing reads the host clock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => state.db }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn(() => true), hasPermissionForLocation: vi.fn(() => true) }))
vi.mock('@/lib/ads/sync', () => ({ syncAccount: vi.fn(async () => ({})) }))
vi.mock('@/lib/ads/providers/meta', () => ({ name: 'meta' }))
vi.mock('@/lib/xero/client', () => ({ withFreshToken: vi.fn(), XeroError: class XeroError extends Error {} }))
vi.mock('@/lib/recon/coverage', () => ({ syncBankLines: vi.fn(async () => ({ pulled: 0, new: 0, covered: 0 })) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const DAY = await import('./ads/account-day.js')
const { loadAdsDashboard } = await import('./ads/read.js')
const { fetchAdsSummary } = await import('@shared/dashboard-data')
const { runCoveragePull } = await import('./recon/pull.js')
const { resetLocationZoneCache } = await import('./location-time.js')
const syncRoute = await import('@/app/api/cron/ad-insights-sync/route.js')
const backfillRoute = await import('@/app/api/cron/ad-insights-backfill/route.js')
const refreshRoute = await import('@/app/api/dashboard/ads/refresh/route.js')
const payablesRoute = await import('@/app/api/accounting/payables/route.js')
const { getCurrentUser } = await import('@/lib/auth')
const { syncAccount } = await import('@/lib/ads/sync')
const { withFreshToken } = await import('@/lib/xero/client')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
// Dublin instants around both 2026 EU DST changes and an ordinary summer and
// winter night. `days` is the Dublin day of now + offset x 24 h (the Meta
// rule); `summarySince` is Dublin's today minus 7 calendar days and
// `attributedSince` now minus 7 x 24 h (fetchAdsSummary); `reconFrom` is
// Dublin's today minus 90 calendar days (the Xero pull floor).
const DUBLIN = [
  { iso: '2026-03-29T23:30:00Z', // 00:30 IST Mon: now - 24 h is two Dublin days back
    days: { 0: '2026-03-30', '-1': '2026-03-28', '-7': '2026-03-22', '-30': '2026-02-27' },
    summarySince: '2026-03-23', attributedSince: '2026-03-22T23:30:00.000Z', reconFrom: '2025-12-30' },
  { iso: '2026-10-24T23:30:00Z', // 00:30 IST Sun, the night of the fall-back
    days: { 0: '2026-10-25', '-1': '2026-10-24', '-7': '2026-10-18', '-30': '2026-09-25' },
    summarySince: '2026-10-18', attributedSince: '2026-10-17T23:30:00.000Z', reconFrom: '2026-07-27' },
  { iso: '2026-10-25T01:00:00Z', // 01:00 GMT, just after the fall-back
    days: { 0: '2026-10-25', '-1': '2026-10-24', '-7': '2026-10-18', '-30': '2026-09-25' },
    summarySince: '2026-10-18', attributedSince: '2026-10-18T01:00:00.000Z', reconFrom: '2026-07-27' },
  { iso: '2026-06-30T23:00:00Z', // 00:00 IST, summer month edge
    days: { 0: '2026-07-01', '-1': '2026-06-30', '-7': '2026-06-24', '-30': '2026-06-01' },
    summarySince: '2026-06-24', attributedSince: '2026-06-23T23:00:00.000Z', reconFrom: '2026-04-02' },
  { iso: '2026-12-31T23:30:00Z', // 23:30 GMT, winter
    days: { 0: '2026-12-31', '-1': '2026-12-30', '-7': '2026-12-24', '-30': '2026-12-01' },
    summarySince: '2026-12-24', attributedSince: '2026-12-24T23:30:00.000Z', reconFrom: '2026-10-02' },
]
const OFFSETS = [-30, -7, -1, 0]

// A thenable query builder keyed by table: `respond(table, calls)` answers it.
function fakeDb(respond) {
  const builders = []
  return {
    builders,
    of: (table) => builders.filter((b) => b.table === table),
    from(table) {
      const b = { table, calls: [] }
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'not', 'order', 'limit', 'range', 'update', 'insert', 'upsert', 'maybeSingle', 'single']) {
        b[m] = (...args) => { b.calls.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve().then(() => respond(table, b.calls)).then(resolve, reject)
      builders.push(b)
      return b
    },
  }
}
const arg = (b, method, col) => b.calls.find((c) => c[0] === method && c[1] === col)?.[2]
const cronReq = (url = 'https://crm.test/api/cron/x') => ({
  url,
  headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer tz11c-secret' : null) },
})

const acct = (id, account_timezone, locTz) => ({
  id, provider: 'meta', is_active: true, location_id: `loc-${id}`, account_timezone,
  locations: locTz === undefined ? undefined : { id: `loc-${id}`, timezone: locTz },
})

beforeEach(() => {
  process.env.CRON_SECRET = 'tz11c-secret'
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetLocationZoneCache()
})
afterEach(() => { vi.useRealTimers() })

// ── the helper ──────────────────────────────────────────────────────────────
describe('TZ.11c adAccountDay: Europe/Dublin pinned values', () => {
  // UN1T's live account (11 Oct 2026): account_timezone NULL, location Europe/Dublin.
  const DUBLIN_ACCOUNTS = [
    ['NULL account zone, Dublin location (UN1T today)', acct('a', null, DUB)],
    ['account zone Europe/Dublin', acct('b', DUB, DUB)],
    ['account zone Europe/London (same rules as Dublin all of 2026)', acct('c', 'Europe/London', DUB)],
    ['no zone anywhere: the platform default', acct('d', null, undefined)],
  ]
  it.each(DUBLIN_ACCOUNTS)('%s', (_label, account) => {
    for (const { iso, days } of DUBLIN) {
      vi.setSystemTime(new Date(iso))
      for (const offsetDays of OFFSETS) {
        expect(DAY.adAccountDay(account, { offsetDays }), `${iso} ${offsetDays}`).toBe(days[offsetDays])
        expect(DAY.adAccountDay(account, { offsetDays, nowMs: Date.parse(iso) })).toBe(days[offsetDays])
      }
    }
  })
})

describe('TZ.11c adAccountDay: America/New_York follows New York across DST', () => {
  const ny = acct('n', NY, DUB) // a New York ad account at a Dublin studio: the ACCOUNT's zone wins
  it.each([
    ['2026-03-08T04:59:00Z', '2026-03-07'], // 23:59 EST
    ['2026-03-08T05:00:00Z', '2026-03-08'], // 00:00 EST: NY midnight, Dublin is already 05:00
    ['2026-03-09T03:59:00Z', '2026-03-08'], // 23:59 EDT
    ['2026-03-09T04:00:00Z', '2026-03-09'], // 00:00 EDT
    ['2026-11-01T03:59:00Z', '2026-10-31'], // 23:59 EDT
    ['2026-11-01T04:00:00Z', '2026-11-01'], // 00:00 EDT
    ['2026-11-02T04:59:00Z', '2026-11-01'], // 23:59 EST: Dublin is already on 2 Nov
    ['2026-11-02T05:00:00Z', '2026-11-02'], // 00:00 EST
  ])('%s is %s in New York', (iso, day) => {
    expect(DAY.adAccountDay(ny, { nowMs: Date.parse(iso) })).toBe(day)
  })

  it('yesterday is now minus 24 h in the account zone (the legacy rule, zone-parameterised)', () => {
    const nowMs = Date.parse('2026-11-02T03:30:00Z') // 1 Nov 22:30 EST
    expect(DAY.adAccountDay(ny, { nowMs, offsetDays: -1 })).toBe('2026-10-31')
    expect(DAY.adAccountDay(ny, { nowMs })).toBe('2026-11-01')
  })

  it('a NULL account zone falls back to the location zone; an invalid one too', () => {
    const nowMs = Date.parse('2026-11-02T03:30:00Z')
    expect(DAY.adAccountZone(acct('x', null, NY))).toBe(NY)
    expect(DAY.adAccountZone(acct('y', 'Mars/Olympus', NY))).toBe(NY)
    expect(DAY.adAccountZone(acct('z', '+05:00', NY))).toBe(NY)
    expect(DAY.adAccountDay(acct('x', null, NY), { nowMs })).toBe('2026-11-01')
    expect(DAY.adAccountZone(acct('w', 'America/Chicago', NY))).toBe('America/Chicago')
  })
})

describe('TZ.11c adsDayZone: the zone ad_insights_daily.date is written in, for one location', () => {
  it('the active Meta account zone, else the account\'s location zone, else a locations read', async () => {
    let row = { account_timezone: NY, locations: { id: 'l1', timezone: DUB } }
    const db = fakeDb((table) => (table === 'ad_accounts' ? { data: row, error: null } : { data: { id: 'l1', timezone: 'Asia/Tokyo' }, error: null }))
    await expect(DAY.adsDayZone(db, 'l1')).resolves.toBe(NY)
    const q = db.of('ad_accounts')[0]
    expect(q.calls).toContainEqual(['eq', 'location_id', 'l1'])
    expect(q.calls).toContainEqual(['eq', 'provider', 'meta'])
    expect(q.calls).toContainEqual(['eq', 'is_active', true])
    row = { account_timezone: null, locations: { id: 'l1', timezone: 'America/Chicago' } }
    await expect(DAY.adsDayZone(db, 'l1')).resolves.toBe('America/Chicago')
    row = null
    await expect(DAY.adsDayZone(db, 'l1')).resolves.toBe('Asia/Tokyo')
  })

  it('a failed ad_accounts read throws (never a silent Dublin); the display wrapper falls back explicitly', async () => {
    const db = fakeDb(() => ({ data: null, error: { message: 'timeout' } }))
    await expect(DAY.adsDayZone(db, 'l2')).rejects.toThrow(/ad_accounts/)
    await expect(DAY.adsDayZoneForDisplay(db, 'l2')).resolves.toBe(DUB)
  })
})

// ── Meta: the three sync routes ────────────────────────────────────────────
function accountsDb(accounts) {
  return fakeDb((table, calls) => {
    if (table === 'ad_accounts' && calls[0]?.[0] === 'select') return { data: accounts, error: null }
    return { data: null, error: null }
  })
}
const windows = () => Object.fromEntries(syncAccount.mock.calls.map(([, a, , o]) => [a.id, [o.since, o.until]]))

describe('TZ.11c ad-insights-sync / backfill / refresh: Europe/Dublin pinned values', () => {
  it.each(DUBLIN.map((d) => [d.iso, d]))('%s', async (iso, { days }) => {
    vi.setSystemTime(new Date(iso))
    const y = days[-1], t = days[0], m = days[-30]

    state.db = accountsDb([acct('s1', null, DUB)])
    await syncRoute.GET(cronReq())
    expect(windows()).toEqual({ s1: [y, t] })
    expect(state.db.of('ad_accounts')[0].calls[0]).toEqual(['select', '*, locations(id, timezone)'])

    syncAccount.mockClear()
    state.db = accountsDb([acct('b1', null, DUB)])
    await backfillRoute.GET(cronReq())
    expect(windows()).toEqual({ b1: [m, t] })

    syncAccount.mockClear()
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    state.db = accountsDb([acct('r1', null, DUB)])
    await refreshRoute.POST({ json: async () => ({ locationId: 'loc-r1' }) })
    expect(windows()).toEqual({ r1: [y, t] })
  })
})

describe('TZ.11c ad-insights-sync / backfill / refresh: each account is asked for its own days', () => {
  const NOW = '2026-11-02T03:30:00Z' // New York 1 Nov 22:30 EST; Dublin 2 Nov 03:30 GMT
  it('ad-insights-sync: a New York account and a Dublin account in one run', async () => {
    vi.setSystemTime(new Date(NOW))
    state.db = accountsDb([acct('ny', NY, DUB), acct('dub', null, DUB), acct('nyloc', null, NY)])
    await syncRoute.GET(cronReq())
    expect(windows()).toEqual({
      ny: ['2026-10-31', '2026-11-01'],
      dub: ['2026-11-01', '2026-11-02'],
      nyloc: ['2026-10-31', '2026-11-01'],
    })
  })

  it('ad-insights-backfill: per-account default window; explicit since/until still win', async () => {
    vi.setSystemTime(new Date(NOW))
    state.db = accountsDb([acct('ny', NY, DUB), acct('dub', null, DUB)])
    await backfillRoute.GET(cronReq())
    expect(windows()).toEqual({ ny: ['2026-10-02', '2026-11-01'], dub: ['2026-10-03', '2026-11-02'] })
    syncAccount.mockClear()
    state.db = accountsDb([acct('ny', NY, DUB), acct('dub', null, DUB)])
    await backfillRoute.GET(cronReq('https://crm.test/api/cron/ad-insights-backfill?since=2026-01-01&until=2026-01-31'))
    expect(windows()).toEqual({ ny: ['2026-01-01', '2026-01-31'], dub: ['2026-01-01', '2026-01-31'] })
  })

  it('dashboard ads refresh: the location\'s New York account', async () => {
    vi.setSystemTime(new Date('2026-03-08T04:30:00Z')) // NY 7 Mar 23:30 EST; Dublin 8 Mar 04:30
    getCurrentUser.mockResolvedValue({ id: 'u1' })
    state.db = accountsDb([acct('ny', NY, NY)])
    await refreshRoute.POST({ json: async () => ({ locationId: 'loc-ny' }) })
    expect(windows()).toEqual({ ny: ['2026-03-06', '2026-03-07'] })
    expect(state.db.of('ad_accounts')[0].calls).toContainEqual(['eq', 'location_id', 'loc-ny'])
  })
})

// ── Meta: the two dashboard reads ─────────────────────────────────────────
function adsDashDb(accountRow, locationTz) {
  return fakeDb((table) => {
    if (table === 'ad_accounts') return { data: accountRow, error: null }
    if (table === 'locations') return { data: { id: 'l', timezone: locationTz }, error: null }
    return { data: [], error: null }
  })
}

describe('TZ.11c loadAdsDashboard (/dashboard/ads, the ad report email)', () => {
  it.each(DUBLIN.map((d) => [d.iso, d]))('Europe/Dublin days at %s', async (iso, { days }) => {
    vi.setSystemTime(new Date(iso))
    for (const sinceDays of [30, 1]) {
      resetLocationZoneCache()
      const db = adsDashDb(null, DUB) // no ad account: the location's zone
      await loadAdsDashboard(db, `l-${sinceDays}`, sinceDays)
      const q = db.of('ad_insights_daily')[0]
      expect(arg(q, 'gte', 'date')).toBe(days[-sinceDays])
      expect(arg(q, 'lte', 'date')).toBe(days[0])
    }
  })

  it('a New York ad account reads New York days around the November fall-back', async () => {
    vi.setSystemTime(new Date('2026-11-02T03:30:00Z'))
    const db = adsDashDb({ account_timezone: NY, locations: { id: 'l', timezone: DUB } }, DUB)
    await loadAdsDashboard(db, 'l-ny', 1)
    for (const q of db.of('ad_insights_daily')) {
      expect(arg(q, 'gte', 'date')).toBe('2026-10-31')
      expect(arg(q, 'lte', 'date')).toBe('2026-11-01')
    }
  })
})

describe('TZ.11c fetchAdsSummary (Business dashboard, last 7 days)', () => {
  function summaryDb() {
    return fakeDb((table) => (table === 'ad_insights_daily' ? { data: [], error: null } : { count: 0, error: null }))
  }
  it.each(DUBLIN.map((d) => [d.iso, d]))('Europe/Dublin (default and explicit) at %s', async (iso, { summarySince, attributedSince }) => {
    const now = new Date(iso)
    for (const zone of [undefined, DUB]) {
      const db = summaryDb()
      await fetchAdsSummary(db, 'loc1', now, zone)
      expect(arg(db.of('ad_insights_daily')[0], 'gte', 'date')).toBe(summarySince)
      expect(arg(db.of('contacts')[0], 'gte', 'attributed_at')).toBe(attributedSince)
    }
  })

  it('in the ad account\'s New York zone the 7 days end on New York\'s today', async () => {
    const db = summaryDb()
    await fetchAdsSummary(db, 'loc1', new Date('2026-11-02T03:30:00Z'), NY) // NY today = 1 Nov
    expect(arg(db.of('ad_insights_daily')[0], 'gte', 'date')).toBe('2026-10-25')
    const db2 = summaryDb()
    await fetchAdsSummary(db2, 'loc1', new Date('2026-03-08T04:30:00Z'), NY) // NY today = 7 Mar
    expect(arg(db2.of('ad_insights_daily')[0], 'gte', 'date')).toBe('2026-02-28')
    // The attributed-leads window is a rolling 7 x 24 h: no zone in it.
    expect(arg(db2.of('contacts')[0], 'gte', 'attributed_at')).toBe('2026-03-01T04:30:00.000Z')
  })
})

// ── Xero: org-local dates in the location's zone (1 location = 1 org) ──────
describe('TZ.11c aged payables (GET /api/accounting/payables)', () => {
  beforeEach(() => {
    withFreshToken.mockResolvedValue({ xfetch: vi.fn(async () => ({ Invoices: [] })) })
  })
  const user = (timezone) => ({ id: 'u', activeLocation: { id: 'loc-p', timezone } })

  it.each(DUBLIN.map((d) => [d.iso, d.days[0]]))('Europe/Dublin at %s ages on %s', async (iso, today) => {
    vi.setSystemTime(new Date(iso))
    getCurrentUser.mockResolvedValue(user(DUB))
    const body = await (await payablesRoute.GET()).json()
    expect(body.data.asOf).toBe(today)
  })

  it('a New York studio ages its Xero bills on New York\'s today', async () => {
    vi.setSystemTime(new Date('2026-11-02T03:30:00Z'))
    getCurrentUser.mockResolvedValue(user(NY))
    withFreshToken.mockResolvedValue({
      xfetch: vi.fn(async () => ({
        Invoices: [{ InvoiceID: 'i1', Type: 'ACCPAY', Status: 'AUTHORISED', DueDateString: '2026-11-01T00:00:00', AmountDue: 10, Total: 10, Contact: { Name: 'Supplier' } }],
      })),
    })
    const body = await (await payablesRoute.GET()).json()
    expect(body.data.asOf).toBe('2026-11-01')
    // Due on New York's today: 0 days, not overdue (in Dublin it is already 2 Nov: 1 day).
    expect(body.data.suppliers[0].bills[0]).toMatchObject({ daysOverdue: 0, bucket: 'not_due' })
  })
})

describe('TZ.11c receipt-coverage Xero pull window (runCoveragePull)', () => {
  function pullDb(locationTz) {
    return fakeDb((table, calls) => {
      if (table === 'recon_runs' && calls.some((c) => c[0] === 'insert')) return { data: { id: 'run-1' }, error: null }
      if (table === 'locations') return { data: { id: 'loc-x', timezone: locationTz }, error: null }
      return { data: null, error: null }
    })
  }
  beforeEach(() => {
    withFreshToken.mockResolvedValue({
      xfetch: vi.fn(async (path) => (path.startsWith('/Accounts') ? { Accounts: [] } : { BankTransactions: [] })),
    })
  })

  it.each(DUBLIN.map((d) => [d.iso, d]))('Europe/Dublin window at %s', async (iso, { days, reconFrom }) => {
    vi.setSystemTime(new Date(iso))
    resetLocationZoneCache()
    const summary = await runCoveragePull(pullDb(DUB), 'loc-x', { trigger: 'manual' })
    expect({ windowFrom: summary.windowFrom, windowTo: summary.windowTo }).toEqual({ windowFrom: reconFrom, windowTo: days[0] })
  })

  it('a New York studio asks Xero for New York days', async () => {
    vi.setSystemTime(new Date('2026-11-02T03:30:00Z'))
    const xfetch = vi.fn(async (path) => (path.startsWith('/Accounts') ? { Accounts: [{ AccountID: 'ba', Status: 'ACTIVE', Name: 'Current' }] } : { BankTransactions: [] }))
    withFreshToken.mockResolvedValue({ xfetch })
    const summary = await runCoveragePull(pullDb(NY), 'loc-x', { trigger: 'manual' })
    expect(summary.windowTo).toBe('2026-11-01')
    expect(summary.windowFrom).toBe('2026-08-03')
    const where = decodeURIComponent(xfetch.mock.calls.find(([p]) => p.startsWith('/BankTransactions'))[0])
    expect(where).toContain('Date<=DateTime(2026,11,1)')
  })

  it('an unreadable location zone fails the run (audited), never a silent Dublin window', async () => {
    const db = fakeDb((table, calls) => {
      if (table === 'recon_runs' && calls.some((c) => c[0] === 'insert')) return { data: { id: 'run-1' }, error: null }
      if (table === 'locations') return { data: null, error: { message: 'timeout' } }
      return { data: null, error: null }
    })
    await expect(runCoveragePull(db, 'loc-err', { trigger: 'manual' })).rejects.toThrow(/locations\.timezone/)
    const audit = db.of('recon_runs').find((b) => b.calls.some((c) => c[0] === 'update' && c[1]?.status === 'error' && /locations/.test(c[1]?.error || '')))
    expect(audit).toBeTruthy()
  })
})

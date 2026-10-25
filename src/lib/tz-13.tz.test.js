// tz-13.tz.test.js — TZ.13 (D7): the web side of the member seam. The first-N
// days journey counts days on the member's home studio clock, and the
// post-class email labels and streaks on the session's studio clock.
//
// (1) Europe/Dublin is pinned by fixed values around both 2026 EU DST changes
// (the byte-identity sweep against a frozen pre-change copy ran in TZ.13 and was
// retired in TZ.18b; zoned-time ≡ dublin-time stays proven by
// shared/zoned-time.parity.test.js); (2) America/New_York follows New York
// across both 2026 US DST changes. The shared modules have their own pair of
// tests in shared/__tests__/tz-13/member-zone.tz.test.js.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ shortName: 'UN1T', companyName: 'UN1T Stillorgan' })) }))

const OJ = await import('./onboarding-journey.js')
const { composeEmail, loadContextForSession } = await import('./hr-post-class-email.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const HOUR = 3_600_000
const DAY = 86_400_000
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
].map(Date.parse)

describe('TZ.13 Europe/Dublin pinned values: the onboarding journey', () => {
  it('daysBetweenIn counts Dublin calendar days across both EU clock changes', () => {
    const d = (a, b, ...zone) => OJ.daysBetweenIn(Date.parse(a), Date.parse(b), ...zone)
    expect(d('2026-03-28T23:30:00Z', '2026-03-29T23:30:00Z', DUB)).toBe(2) // 23:30 GMT Sat → 00:30 IST Mon
    expect(d('2026-03-29T00:30:00Z', '2026-03-29T22:30:00Z', DUB)).toBe(0) // 00:30 GMT → 23:30 IST, both Sun
    expect(d('2026-03-29T22:30:00Z', '2026-03-29T23:30:00Z', DUB)).toBe(1) // one hour across IST midnight
    expect(d('2026-10-24T22:30:00Z', '2026-10-24T23:30:00Z', DUB)).toBe(1) // 23:30 IST Sat → 00:30 IST Sun
    expect(d('2026-10-24T23:30:00Z', '2026-10-25T23:30:00Z', DUB)).toBe(0) // 24 hours inside the 25-hour Sunday
    expect(d('2026-07-01T22:30:00Z', '2026-07-01T23:30:00Z')).toBe(1) // zone omitted = Dublin
    expect(d('2026-01-15T23:30:00Z', '2026-01-16T00:30:00Z')).toBe(1)
    expect(d('2026-03-28T23:30:00Z', '2026-03-29T23:30:00Z')).toBe(2) // 23:30 GMT Sat → 00:30 IST Mon
  })
  it('journeyStatus: the day index is the Dublin day (explicit or omitted zone)', () => {
    const config = { windowDays: 42, targetClasses: 3 }
    const at = (s) => {
      const now = Date.parse(s)
      return {
        joinedAt: new Date(now - 20 * DAY - 0.5 * HOUR).toISOString(),
        attendedAt: [now - 19 * DAY - 23.5 * HOUR, now - 11 * DAY, now - 0.5 * HOUR].map((t) => new Date(t).toISOString()),
        now,
        config,
      }
    }
    // Joined 23:00 GMT Mon 9 Mar; now 00:30 IST Mon 30 Mar: day 21.
    expect(OJ.journeyStatus(at('2026-03-29T23:30:00Z'), DUB)).toMatchObject({ dayIndex: 21, weekIndex: 4, attended: 3, status: 'completed', completedAt: '2026-03-29T23:00:00.000Z', completedDaysAgo: 0 })
    expect(OJ.journeyStatus(at('2026-07-01T23:30:00Z'))).toMatchObject({ dayIndex: 20, weekIndex: 3, status: 'completed' })
    // Joined 00:00 IST Tue 6 Oct; now 23:30 GMT Sun 25 Oct: day 19.
    expect(OJ.journeyStatus(at('2026-10-25T23:30:00Z'), DUB)).toMatchObject({ dayIndex: 19, weekIndex: 3, lastAttendedAt: '2026-10-25T23:00:00.000Z' })
    expect(OJ.journeyStatus(at('2026-01-15T12:00:00Z'), DUB)).toMatchObject({ dayIndex: 20, inWindow: true, expectedByNow: 1 })
  })
})

describe('TZ.13 America/New_York: the onboarding journey counts New York days', () => {
  it('a member who joined at 23:30 EDT is on day 1 at 00:30 EDT, not day 0', () => {
    const joined = Date.parse('2026-07-10T03:30:00Z') // 23:30 EDT Thu 9 Jul (04:30 IST Fri 10 Jul)
    const now = Date.parse('2026-07-10T04:30:00Z') // 00:30 EDT Fri 10 Jul
    expect(OJ.daysBetweenIn(joined, now, NY)).toBe(1)
    expect(OJ.daysBetweenIn(joined, now, DUB)).toBe(0)
    expect(OJ.journeyStatus({ joinedAt: joined, now }, NY).dayIndex).toBe(1)
  })

  it('across the US clock changes a NY day is one calendar day, 23 or 25 hours long', () => {
    // Sat 7 Mar 12:00 EST → Mon 9 Mar 12:00 EDT: two NY days, 47 hours.
    expect(OJ.daysBetweenIn(Date.parse('2026-03-07T17:00:00Z'), Date.parse('2026-03-09T16:00:00Z'), NY)).toBe(2)
    // 23:30 EDT Sat 31 Oct → 00:30 EST Mon 2 Nov: two NY days, 26 hours.
    expect(OJ.daysBetweenIn(Date.parse('2026-11-01T03:30:00Z'), Date.parse('2026-11-02T05:30:00Z'), NY)).toBe(2)
  })
})

// The post-class email: label + streak on the session's studio clock.
function ctx(zone, startedAt = '2026-11-01T03:30:00Z') {
  const s = {
    id: 'sess-1', contact_id: 'c-1', location_id: 'loc-1', started_at: startedAt,
    ended_at: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
    avg_hr_bpm: 140, peak_hr_bpm: 170, zones_seconds: { 3: 600 }, effort_points: 100,
  }
  const out = {
    ok: true, session: s,
    thisSession: { id: s.id, started_at: startedAt, class_name: 'RIDE', effort_points: 100, zones_seconds: s.zones_seconds },
    history: [], eventTypeName: 'RIDE',
    contact: { id: 'c-1', name: 'Test Member', email: 'member@example.test' },
    unsubscribeToken: 't', shortName: 'UN1T', companyName: 'UN1T Stillorgan',
  }
  if (zone !== undefined) out.zone = zone
  return out
}

describe('TZ.13 the post-class email reads the studio clock', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test') })
  afterEach(() => { vi.unstubAllEnvs() })

  it('Europe/Dublin (explicit or absent) renders exactly what it did', () => {
    for (const ms of SAMPLES) {
      const at = new Date(ms).toISOString()
      const a = composeEmail(ctx(undefined, at), { nowMs: ms + HOUR })
      const b = composeEmail(ctx(DUB, at), { nowMs: ms + HOUR })
      expect(b).toStrictEqual(a)
    }
    // 03:30Z on 1 Nov is 03:30 GMT: the Dublin label.
    expect(composeEmail(ctx(DUB), { nowMs: Date.parse('2026-11-01T05:00:00Z') }).text).toContain('Sun, 1 Nov, 03:30')
  })

  it('a New York studio labels the session in New York time', () => {
    // 03:30Z on 1 Nov is 23:30 EDT on Sat 31 Oct.
    const out = composeEmail(ctx(NY), { nowMs: Date.parse('2026-11-01T05:00:00Z') })
    expect(out.text).toContain('Sat, 31 Oct, 23:30')
    expect(out.html).toContain('Sat, 31 Oct, 23:30')
  })

  it('a New York streak counts New York days', () => {
    // 23:30 EDT Sat 31 Oct, with sessions on NY Fri 30 and Thu 29 Oct.
    const c = ctx(NY)
    c.history = [
      { id: 'h1', started_at: '2026-10-30T22:00:00Z', class_name: 'RIDE', effort_points: 200, peak_hr_bpm: 190 },
      { id: 'h2', started_at: '2026-10-29T22:00:00Z', class_name: 'RIDE', effort_points: 200, peak_hr_bpm: 190 },
    ]
    const now = Date.parse('2026-11-01T05:00:00Z')
    expect(composeEmail(c, { nowMs: now }).text).toContain('3-day streak')
    // In Dublin the session is Sun 1 Nov, after a gap on Sat 31 Oct: no streak line.
    expect(composeEmail({ ...c, zone: DUB }, { nowMs: now }).text).not.toContain('-day streak')
  })

  it('loadContextForSession reads the zone with the location settings, in one read', async () => {
    const selects = []
    const chain = (table) => {
      const b = {}
      for (const m of ['eq', 'gte', 'not', 'order', 'limit']) b[m] = () => b
      b.select = (cols) => { selects.push([table, cols]); return b }
      const rows = {
        heart_rate_sessions: { data: { ...ctx(NY).session, ended_at: '2026-11-01T04:15:00Z', email_sent_at: null, contact: { id: 'c-1' }, booking: null }, error: null },
        locations: { data: { id: 'loc-1', settings: {}, timezone: NY }, error: null },
      }
      b.single = async () => rows[table] || { data: null, error: null }
      // MIAORG.1 — the row comes through resolveAgentSettings (maybeSingle).
      b.maybeSingle = async () => (table === 'locations' ? rows.locations : { data: null, error: null })
      b.then = (res) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    }
    const out = await loadContextForSession({ from: chain }, 'sess-1')
    expect(out.ok).toBe(true)
    expect(out.zone).toBe(NY)
    expect(selects.filter(([t]) => t === 'locations')).toEqual([['locations', 'id, name, timezone, organization_id, membership_source, settings']])
  })
})

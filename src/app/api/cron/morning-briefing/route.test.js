// ROUTEWRAP.C8 — morning-briefing on defineCron: the secret, the one stamp on a
// slot tick, and fixed error text. Which location acts at which tick is pinned
// in ../daily-slot-location-crons.tz6.test.js; here the send libs are spies.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { withSlotTables } from '@/lib/cron-daily-slot.test-helpers'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => h.db) }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/today-feed-data', () => ({ fetchLocationTodayFeed: vi.fn(async () => [{ id: 'row-1' }]) }))
vi.mock('@/lib/studio-pulse-data', () => ({ fetchStudioPulse: vi.fn(async () => null) }))
vi.mock('@/lib/owner-daily-headline', () => ({ fetchDailyHeadline: vi.fn(async () => null) }))
vi.mock('@/lib/morning-briefing', () => ({
  buildMorningBriefingEmail: vi.fn(() => ({ subject: 'Briefing', html: '<p/>' })),
  shapePulseMetrics: vi.fn(() => []),
}))
vi.mock('@/lib/membership/locations-for-source', () => ({ locationIdsWithoutCapability: vi.fn(async () => ({ ids: new Set(), error: null })) }))

const { GET } = await import('./route.js')
const { createServerClient } = await import('@/lib/supabase')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { sendEmail } = await import('@/lib/postmark')
const { fetchLocationTodayFeed } = await import('@/lib/today-feed-data')
const { logError, logWarn } = await import('@/lib/log')

const DUB = 'a0000000-0000-4000-8000-000000000001'
const GAL = 'a0000000-0000-4000-8000-000000000002'
const LOCATIONS = [
  { id: DUB, name: 'Dublin studio', active: true, timezone: 'Europe/Dublin', churn_digest_recipients: ['ops@example.test', 'owner@example.test'] },
  { id: GAL, name: 'Galway studio', active: true, timezone: 'Europe/Dublin', churn_digest_recipients: [] },
]
const SLOT = '2026-07-06T06:00:00Z'
const req = (auth = 'Bearer shh') => new Request('https://x.test/api/cron/morning-briefing', { headers: auth ? { authorization: auth } : {} })
const dbWith = (errors) => {
  h.db = withSlotTables(createFakeDb({ tables: { locations: LOCATIONS }, errors }), { locations: LOCATIONS.map(({ id, timezone }) => ({ id, timezone })) })
}
const at = async (iso, auth) => { vi.setSystemTime(Date.parse(iso)); return GET(req(auth)) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.CRON_SECRET = 'shh'
  dbWith()
})

describe('GET /api/cron/morning-briefing', () => {
  it('401 without the secret: nothing read, nothing sent, nothing stamped', async () => {
    for (const auth of [null, 'Bearer wrong']) expect((await at(SLOT, auth)).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await at(SLOT, 'Bearer undefined')).status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a slot tick emails each recipient once and stamps only morning-briefing', async () => {
    const res = await at(SLOT)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, emails_sent: 2,
      perLocation: [{ location_id: DUB, location_name: 'Dublin studio', rows: 1, recipients: 2, ok: true }],
    })
    expect(sendEmail.mock.calls.map(([a]) => a.to)).toEqual(['ops@example.test', 'owner@example.test'])
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ stream: 'outbound', tag: 'morning-briefing' }))
    expect(stampHeartbeat.mock.calls).toEqual([['morning-briefing']])
  })

  it('a quiet tick sends nothing and stamps nothing', async () => {
    const res = await at('2026-07-06T05:00:00Z')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, emails_sent: 0, perLocation: [] })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable locations list is a 500 with a fixed line (no DB text), nothing sent, no stamp', async () => {
    dbWith({ locations: { select: { code: 'XX000', message: 'relation db.internal refused' } } })
    const res = await at(SLOT)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not list locations' })
    expect(logError).toHaveBeenCalledWith('morning-briefing', 'failed to list locations', expect.objectContaining({ err: expect.objectContaining({ code: 'XX000' }) }))
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('every location with a briefing failing is a 500 with fixed per-location text and no stamp', async () => {
    fetchLocationTodayFeed.mockRejectedValueOnce(new Error('timeout talking to db.internal'))
    const res = await at(SLOT)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({
      success: false, error: 'Every location failed', emails_sent: 0,
      perLocation: [{ location_id: DUB, location_name: 'Dublin studio', ok: false, error: 'briefing failed' }],
    })
    expect(logWarn).toHaveBeenCalledWith('morning-briefing', 'briefing failed for location', expect.objectContaining({ locationId: DUB }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
  it('one location failing is reported in its row and the tick still stamps', async () => {
    LOCATIONS[1].churn_digest_recipients = ['galway@example.test']
    dbWith()
    fetchLocationTodayFeed.mockRejectedValueOnce(new Error('timeout talking to db.internal'))
    const res = await at(SLOT)
    LOCATIONS[1].churn_digest_recipients = []
    expect(res.status).toBe(200)
    expect((await res.json()).perLocation.map((p) => p.ok)).toEqual([false, true])
    expect(sendEmail.mock.calls.map(([a]) => a.to)).toEqual(['galway@example.test'])
    expect(stampHeartbeat.mock.calls).toEqual([['morning-briefing']])
  })
})

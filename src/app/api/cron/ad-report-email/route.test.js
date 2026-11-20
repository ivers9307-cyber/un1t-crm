// ROUTEWRAP.C5 — ad-report-email on defineCron: the secret, the stamp on a slot
// tick, no stamp on a quiet tick, and an unreadable locations list answering
// 500 unstamped (it used to loop over nothing and stamp). The studio date is
// route.tz.test.js; which studio acts at which tick is
// ../daily-slot-location-crons.tz6.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/ads/read', () => ({ loadAdsDashboard: vi.fn(async () => ({ kpis: {}, perAd: [] })) }))
vi.mock('@/lib/ads/report', () => ({ buildAdReportEmail: vi.fn(() => ({ subject: 's', html: 'h' })) }))
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn(async () => ({})) }))
vi.mock('@/lib/cron-daily-slot', async (importOriginal) => ({ ...(await importOriginal()), gateDailySlot: vi.fn() }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { sendEmail } = await import('@/lib/postmark')
const { loadAdsDashboard } = await import('@/lib/ads/read')
const { gateDailySlot } = await import('@/lib/cron-daily-slot')
const { openGate } = await import('@/lib/cron-daily-slot.test-helpers')
const { logError, logWarn } = await import('@/lib/log')

const LOC = { id: 'loc-1', name: 'Studio', active: true, timezone: 'Europe/Dublin', settings: { ads: { report_recipients: ['ops@example.test'] } } }
const ACC = { id: 'acc-1', location_id: 'loc-1', provider: 'meta', external_account_id: 'act_1', is_active: true }
const req = (secret = 'shh') =>
  new Request('https://x.test/api/cron/ad-report-email', { headers: { authorization: `Bearer ${secret}` } })
const seed = (extra = {}) => createFakeDb({ tables: { locations: [LOC], ad_accounts: [ACC] }, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  db = seed()
  gateDailySlot.mockImplementation(openGate)
})

describe('GET /api/cron/ad-report-email', () => {
  it('401s without the secret, reading nothing and stamping nothing', async () => {
    const res = await GET(req('wrong'))
    expect(res.status).toBe(401)
    expect(gateDailySlot).not.toHaveBeenCalled()
    expect(db.calls).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a slot tick sends the report and stamps its own row only', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, results: [{ loc: 'loc-1', sent: 1 }] })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-report-email')
  })

  it('a quiet tick answers success and stamps nothing', async () => {
    gateDailySlot.mockResolvedValue({ ok: true, faulted: false, slots: new Map(), summary: { due: 0 } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, results: [], slot: { due: 0 } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one studio failing is a result with a fixed line; the tick still stamps', async () => {
    loadAdsDashboard.mockRejectedValueOnce(new Error('Meta says secret_r'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([{ loc: 'loc-1', error: 'report failed' }])
    expect(JSON.stringify(body)).not.toContain('secret_r')
    expect(logWarn).toHaveBeenCalledWith('ad-report-email', 'report failed for location', expect.objectContaining({ locationId: 'loc-1' }))
    expect(stampHeartbeat).toHaveBeenCalledWith('ad-report-email')
  })

  it('an unreadable locations list is a failed run: 500, a fixed line, nothing sent or stamped', async () => {
    db = seed({ errors: { locations: { select: { message: 'relation secret_l does not exist' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read the locations' })
    expect(JSON.stringify(body)).not.toContain('secret_l')
    expect(sendEmail).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('ad-report-email', expect.stringMatching(/read failed/), expect.anything())
  })

  it('an unreadable gate is a failed run with no stamp', async () => {
    gateDailySlot.mockResolvedValue({ ok: false, faulted: true, slots: new Map(), summary: { unread: 1 } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'locations unreadable', slot: { unread: 1 } })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

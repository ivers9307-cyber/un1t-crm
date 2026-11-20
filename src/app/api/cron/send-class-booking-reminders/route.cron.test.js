// ROUTEWRAP.C10 — send-class-booking-reminders on defineCron. The wrapper owns
// the secret check, the error boundary and the stamp; every path stamps or
// withholds the heartbeat exactly as the hand-rolled handler did.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: (s) => s === 'claim_failed',
}))

const { GET, POST } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { sendNudgeOnce } = await import('@/lib/customer-nudge-claim')

const NOW = Date.parse('2026-11-20T17:00:00Z')
const L1 = 'a0000000-0000-0000-0000-000000000001'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const B1 = 'b0000000-0000-0000-0000-000000000001'
const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/send-class-booking-reminders', { headers: authorization ? { authorization } : {} })

function seed({ bookings = true } = {}) {
  return createFakeDb({
    tables: {
      locations: [{ id: L1, timezone: 'Europe/Dublin', notification_config: null, membership_source: 'glofox' }],
      class_bookings: bookings
        ? [{ id: B1, contact_id: C1, location_id: L1, class_name: 'HIIT', starts_at: new Date(NOW + 30 * 60_000).toISOString(), source_platform: 'glofox', status: 'BOOKED' }]
        : [],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = seed()
})

describe('GET /api/cron/send-class-booking-reminders on defineCron', () => {
  it('refuses a caller without the cron secret (GET and POST): no client, nothing sent or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) {
      expect((await GET(req(auth))).status).toBe(401)
      expect((await POST(req(auth))).status).toBe(401)
    }
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run sends the due reminder and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, ok: true, due: 1, sent: 1 })
    expect(sendNudgeOnce).toHaveBeenCalledTimes(1)
    expect(stampHeartbeat.mock.calls).toEqual([['send-class-booking-reminders']])
  })

  it('nothing booked is a clean run and stamps', async () => {
    h.db = seed({ bookings: false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, due: 0, sent: 0 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('an unreadable locations table: 500, fixed line, nothing sent or stamped', async () => {
    h.db.errors.locations = { select: { message: 'permission denied for table locations' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, ok: false, error: 'locations unreadable' })
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable bookings table: 500, fixed line, nothing stamped', async () => {
    h.db.errors.class_bookings = { select: { message: 'statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, ok: false, error: 'bookings unreadable' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a send that throws is a failed run: fixed 500, nothing stamped', async () => {
    sendNudgeOnce.mockRejectedValueOnce(new Error('expo exploded at +353 87 000 0000'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Cron run failed' })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

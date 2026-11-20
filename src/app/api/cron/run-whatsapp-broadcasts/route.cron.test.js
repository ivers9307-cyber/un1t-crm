// ROUTEWRAP.C12 — the WhatsApp broadcast cron on defineCron. The wrapper owns
// the secret check and the 'run-whatsapp-broadcasts' stamp; the three arms
// (scheduled promotion, blast resume, in-flight drips) are unchanged and are
// pinned by the other route.*.test.js files here. These tests pin who is
// refused, when the row is stamped, and that Meta or database text never
// reaches the response. Fictional ids and numbers.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  sendDripChunk: vi.fn(async () => ({ sent: 1, failed: 0, status: 'sending' })),
  sendBroadcast: vi.fn(async () => ({ sent: 2, failed: 0, status: 'sending' })),
}))
vi.mock('@/lib/whatsapp-drip', () => ({ isWithinSendWindow: () => true }))
vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn(async () => {}) }))

const { GET } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { logError } = await import('@/lib/log')
const { sendDripChunk, sendBroadcast } = await import('@/lib/whatsapp')

const A = 'a0000000-0000-4000-8000-00000000000a'
const RESUME = 'b0000000-0000-4000-8000-000000000001'
const DRIP = 'b0000000-0000-4000-8000-000000000002'
const PAST = new Date(Date.now() - 10 * 60_000).toISOString()
const base = { name: 'Broadcast', location_id: A, paused_at: null, updated_at: PAST, send_window_start: '00:00', send_window_end: '23:59', send_window_tz: 'Europe/Dublin' }

const seed = ({ broadcasts = true, errors = {} } = {}) => createFakeDb({
  tables: {
    locations: [{ id: A, features: { whatsapp: true } }],
    whatsapp_broadcasts: broadcasts
      ? [
          { ...base, id: RESUME, status: 'sending', delivery_mode: 'blast', scheduled_at: PAST },
          { ...base, id: DRIP, status: 'sending', delivery_mode: 'drip', scheduled_at: null },
        ]
      : [],
    whatsapp_broadcast_recipients: [{ id: 'c0000000-0000-4000-8000-000000000001', broadcast_id: RESUME, created_at: new Date().toISOString() }],
  },
  errors,
})

const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/run-whatsapp-broadcasts', { headers: authorization ? { authorization } : {} })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'shh'
  h.clients = 0
  h.db = seed()
})

describe('GET /api/cron/run-whatsapp-broadcasts on defineCron', () => {
  it('refuses a missing, wrong or unset secret: nothing read, sent or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) expect((await GET(req(auth))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(h.db.calls).toHaveLength(0)
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(sendDripChunk).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run resumes the blast, sends the drip chunk and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.stats).toMatchObject({ resume_found: 1, found: 1, sent: 3, errors: [] })
    expect(sendBroadcast).toHaveBeenCalledWith(RESUME, expect.any(Object))
    expect(sendDripChunk).toHaveBeenCalledWith(DRIP)
    expect(stampHeartbeat.mock.calls).toEqual([['run-whatsapp-broadcasts']])
  })

  it('nothing due is a clean run: stamped', async () => {
    h.db = seed({ broadcasts: false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(stampHeartbeat.mock.calls).toEqual([['run-whatsapp-broadcasts']])
  })

  it('a failing send is one broadcast, not the run: fixed lines, no Meta text or phone number, stamped', async () => {
    sendDripChunk.mockRejectedValueOnce(new Error('(#131026) Message undeliverable to +353 87 000 0000'))
    sendBroadcast.mockRejectedValueOnce(new Error('tier budget exhausted for WABA 1234567890'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats.errors).toEqual([
      { broadcast_id: RESUME, error: 'resume failed' },
      { broadcast_id: DRIP, error: 'drip chunk failed' },
    ])
    expect(JSON.stringify(body)).not.toMatch(/\+353|131026|1234567890/)
    expect(stampHeartbeat.mock.calls).toEqual([['run-whatsapp-broadcasts']])
  })

  it('an unreadable last send skips that resume with a fixed line (no database text)', async () => {
    h.db = seed({ errors: { whatsapp_broadcast_recipients: { select: { code: 'XX000', message: 'relation secret_tbl is broken' } } } })
    const body = await (await GET(req())).json()
    expect(body.stats.errors).toEqual([{ broadcast_id: RESUME, error: 'last-send read failed' }])
    expect(JSON.stringify(body)).not.toContain('secret_tbl')
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(stampHeartbeat.mock.calls).toEqual([['run-whatsapp-broadcasts']])
  })

  it('an unreadable broadcast list: 500, fixed line, no database text, nothing sent or stamped', async () => {
    h.db = seed({ errors: { whatsapp_broadcasts: { select: { message: 'column whatsapp_broadcasts.secret_col does not exist' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ success: false, error: 'Could not read the broadcasts' })
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(sendDripChunk).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron:run-whatsapp-broadcasts', expect.any(String), expect.objectContaining({ err: expect.any(Object) }))
  })

  it('an unreadable studio list still fails closed: 500, nothing sent or stamped', async () => {
    h.db = seed({ errors: { locations: { select: { message: 'boom' } } } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not read the studios\' WhatsApp setting' })
    expect(sendBroadcast).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

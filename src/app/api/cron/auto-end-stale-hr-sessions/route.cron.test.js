// ROUTEWRAP.C10 — auto-end-stale-hr-sessions on defineCron. The wrapper owns
// the secret check, the error boundary and the stamp. A failed read used to be
// dropped (read as "nothing stale, nothing to email") under a clean heartbeat;
// it now answers 500 with a count and no stamp.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/live-class', () => ({ endSession: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/hr-post-class-email', () => ({ sendPostClassEmail: vi.fn(async () => ({ ok: true, sent: false })) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(async () => {}) }))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ shortName: 'UN1T' })) }))

const { GET, POST } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { endSession } = await import('@/lib/live-class')
const { logError } = await import('@/lib/log')

const NOW = Date.parse('2026-11-20T19:00:00Z')
const S1 = 'e0000000-0000-0000-0000-000000000001'
const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/auto-end-stale-hr-sessions', { headers: authorization ? { authorization } : {} })

function seed() {
  return createFakeDb({
    tables: {
      // A strap silent for 20 minutes, no class: closed this tick.
      heart_rate_sessions: [{
        id: S1, contact_id: null, location_id: null, ended_at: null, email_sent_at: null, source: null, glofox_event_id: null,
        started_at: new Date(NOW - 40 * 60_000).toISOString(), last_sample_at: new Date(NOW - 20 * 60_000).toISOString(),
      }],
      class_occurrences: [],
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

describe('GET /api/cron/auto-end-stale-hr-sessions on defineCron', () => {
  it('refuses a caller without the cron secret (GET and POST): no client, nothing closed or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) {
      expect((await GET(req(auth))).status).toBe(401)
      expect((await POST(req(auth))).status).toBe(401)
    }
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(endSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run closes the silent session and stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true, ok: true, ended: 1, end_failed: 0, emails_sent: 0, emails_skipped: 0, emails_failed: 0, stale_retired: 0,
    })
    expect(endSession).toHaveBeenCalledWith(h.db, S1, { nowMs: NOW })
    expect(stampHeartbeat.mock.calls).toEqual([['auto-end-stale-hr-sessions']])
  })

  it('one session that fails to close is one bad row: still a clean run, stamped', async () => {
    endSession.mockResolvedValueOnce({ ok: false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, ended: 0, end_failed: 1 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('an unreadable sessions table is not "nothing stale": 500, a count, no database text, no stamp', async () => {
    h.db.errors.heart_rate_sessions = { select: { message: 'permission denied for table heart_rate_sessions' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({
      success: false, ok: false, ended: 0, end_failed: 0, emails_sent: 0, emails_skipped: 0, emails_failed: 0, stale_retired: 0, reads_failed: 5,
    })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    expect(endSession).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-auto-end-hr', expect.stringMatching(/read failed/), expect.objectContaining({ err: expect.any(Object) }))
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed class_occurrences read still runs the sweep as before but withholds the heartbeat', async () => {
    h.db.tables.heart_rate_sessions[0].glofox_event_id = 'ev-1'
    h.db.errors.class_occurrences = { select: { message: 'timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, reads_failed: 1 })
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

// ROUTEWRAP.C10 — credit-attendance on defineCron. The wrapper owns the secret
// check, the error boundary and the stamp. What the job writes, and in what
// order, is unchanged; a failed bookings page or a failed read of the sessions
// that already exist no longer stamps a clean heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'

const h = vi.hoisted(() => ({ db: null, clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/live-class', () => ({
  createParticipationSession: vi.fn(async () => 'hr-new'),
  finalizeSessionRewards: vi.fn(async () => {}),
}))
vi.mock('@/lib/heart-rate', () => ({ resolveScoringConfig: () => ({ participationPoints: 10 }), resolveMaxHr: () => 190 }))

const { GET, POST } = await import('./route.js')
const { stampHeartbeat } = await import('@/lib/cron-heartbeat')
const { createParticipationSession, finalizeSessionRewards } = await import('@/lib/live-class')

const NOW = Date.parse('2026-11-20T03:00:00Z')
const L1 = 'a0000000-0000-0000-0000-000000000001'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const C2 = 'c0000000-0000-0000-0000-000000000002'
const req = (authorization = 'Bearer shh') =>
  new Request('https://x.test/api/cron/credit-attendance', { headers: authorization ? { authorization } : {} })

function seed() {
  const startsAt = new Date(NOW - 3 * 3600_000).toISOString()
  return createFakeDb({
    tables: {
      locations: [{ id: L1, settings: {}, membership_source: 'glofox' }],
      class_bookings: [
        { id: 'b0000000-0000-0000-0000-000000000001', location_id: L1, glofox_event_id: 'ev-1', contact_id: C1, class_name: 'HIIT', starts_at: startsAt, source_platform: 'glofox', attended: true },
        { id: 'b0000000-0000-0000-0000-000000000002', location_id: L1, glofox_event_id: 'ev-1', contact_id: C2, class_name: 'HIIT', starts_at: startsAt, source_platform: 'glofox', attended: true },
      ],
      // C2 already has a session for ev-1: never credited twice.
      heart_rate_sessions: [{ id: 'd0000000-0000-0000-0000-000000000001', contact_id: C2, glofox_event_id: 'ev-1' }],
      contacts: [{ id: C1, max_hr_override: null, dob: null }, { id: C2, max_hr_override: null, dob: null }],
      class_occurrences: [{ glofox_event_id: 'ev-1', ends_at: new Date(NOW - 2 * 3600_000).toISOString(), cancelled_at: null }],
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

describe('GET /api/cron/credit-attendance on defineCron', () => {
  it('refuses a caller without the cron secret (GET and POST): no client, nothing credited or stamped', async () => {
    for (const auth of [null, 'Bearer nope']) {
      expect((await GET(req(auth))).status).toBe(401)
      expect((await POST(req(auth))).status).toBe(401)
    }
    delete process.env.CRON_SECRET
    expect((await GET(req())).status).toBe(401)
    expect(h.clients).toBe(0)
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a clean run credits the uncredited attendee only, then stamps exactly its own row', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, credited: 1, scanned: 2, skipped_no_source: 0, skipped_un1t_online: 0 })
    expect(createParticipationSession).toHaveBeenCalledTimes(1)
    expect(createParticipationSession).toHaveBeenCalledWith(h.db, expect.objectContaining({ contactId: C1, glofoxEventId: 'ev-1', participationPoints: 10, maxHr: 190 }))
    expect(finalizeSessionRewards).toHaveBeenCalledWith(h.db, 'hr-new', expect.any(Object))
    expect(stampHeartbeat.mock.calls).toEqual([['credit-attendance']])
  })

  it('a failed bookings read is not "nothing attended": 500, fixed line, nothing credited or stamped', async () => {
    h.db.errors.class_bookings = { select: { message: 'statement timeout' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, credited: 0, scanned: 0, bookings_unread: 1, error: 'A read failed; the run is not clean' })
    expect(JSON.stringify(body)).not.toContain('statement timeout')
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed existing-sessions read credits as before but answers 500 and withholds the heartbeat', async () => {
    h.db.errors.heart_rate_sessions = { select: { message: 'permission denied for table heart_rate_sessions' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, credited: 2, scanned: 2, sessions_unread: 1 })
    expect(JSON.stringify(body)).not.toContain('permission denied')
    // Writes unchanged: with no existing sessions read, both bookings are credited (as before).
    expect(createParticipationSession).toHaveBeenCalledTimes(2)
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('an unreadable locations table: 500 with a fixed line, nothing credited or stamped', async () => {
    h.db.errors.locations = { select: { message: 'permission denied for table locations' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'locations load failed' })
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('one credit that throws is one bad row: the run is still clean and stamps', async () => {
    finalizeSessionRewards.mockRejectedValueOnce(new Error('reward cascade failed'))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, credited: 0, scanned: 2 })
    expect(stampHeartbeat).toHaveBeenCalledTimes(1)
  })
})

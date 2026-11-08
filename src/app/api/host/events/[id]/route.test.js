// HOSTSERIES.1 — GET/PUT /api/host/events/[id] with sessions[]: the GET
// hands the form HH:MM sessions; the PUT re-reviews only an existing time
// change and answers 409 when the sync refuses.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let session
let db
let row
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-slug', async (importOriginal) => ({ ...(await importOriginal()), uniqueEventSlug: vi.fn(async (_db, base) => base) }))
vi.mock('@/lib/host-org-brand', () => ({ resolveHostOrgBrand: vi.fn(async () => ({ name: 'UN1T' })) }))
vi.mock('@/lib/event-sessions', async (importOriginal) => ({ ...(await importOriginal()), syncEventSessions: vi.fn(), judgeSessions: vi.fn() }))

const { syncEventSessions, judgeSessions } = await import('@/lib/event-sessions')
const { GET, PUT } = await import('./route.js')

const props = () => ({ params: Promise.resolve({ id: E1 }) })
const BODY = {
  kind: 'workshop', name: 'Mobility', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  ticket_price_cents: 2500, venue_name: 'Studio 1',
  sessions: [{ id: W1, start_time: '10:00', capacity: 20 }],
}
const put = (body) => PUT(new Request(`https://crm.test/api/host/events/${E1}`, { method: 'PUT', body: JSON.stringify(body) }), props())

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  row = {
    id: E1, host_id: 'h1', status: 'published', kind: 'workshop', name: 'Mobility', slug: 'studio-1-dec05-1000', race_date: '2026-12-05',
    allowed_team_sizes: [1, 2], non_member_fee_cents: 2500, venue_name: 'Studio 1', series_id: null,
    race_waves: [{ id: W1, start_time: '10:00:00', capacity: 20, label: null, display_order: 0 }],
  }
  db = fakeDb((q) => {
    if (q.table === 'race_events' && q.action === 'select') return { data: row, error: null }
    if (q.table === 'event_series') return { data: { id: q.ops.find((o) => o[0] === 'eq' && o[1] === 'id')?.[2], host_id: 'h1' }, error: null }
    return { data: null, error: null }
  })
  syncEventSessions.mockResolvedValue({ ok: true, waves: [] })
  judgeSessions.mockResolvedValue({ ok: true })
})

describe('GET /api/host/events/[id]', () => {
  it('returns sessions as HH:MM and the series id', async () => {
    const res = await GET(new Request('https://crm.test'), props())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.sessions).toEqual([{ id: W1, start_time: '10:00', label: null, capacity: 20 }])
    expect(j.data.series_id).toBeNull()
  })
  it('404 for another host\'s event', async () => {
    row.host_id = 'h2'
    expect((await GET(new Request('https://crm.test'), props())).status).toBe(404)
  })
})

describe('PUT /api/host/events/[id]', () => {
  it('adding a session to a published event keeps it published and syncs both', async () => {
    const res = await put({ ...BODY, sessions: [...BODY.sessions, { start_time: '14:00', capacity: 10 }] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published', reReview: false } })
    expect(syncEventSessions).toHaveBeenCalledTimes(1)
    expect(syncEventSessions.mock.calls[0][1]).toMatchObject({ eventId: E1, currentWaves: row.race_waves })
    expect(syncEventSessions.mock.calls[0][1].sessions).toHaveLength(2)
  })
  it('changing the existing session\'s time sends it back to review', async () => {
    const res = await put({ ...BODY, sessions: [{ id: W1, start_time: '11:00', capacity: 20 }] })
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'pending_review', reReview: true } })
    const update = db.queries.find((q) => q.table === 'race_events' && q.action === 'update')
    expect(update.payload).toMatchObject({ status: 'pending_review', reviewed_at: null })
    expect(update.payload.submitted_at).toBeTruthy()
  })
  it('writes series_id when the body carries it', async () => {
    await put({ ...BODY, series_id: 'd0000000-0000-4000-8000-0000000000d1' })
    const update = db.queries.find((q) => q.table === 'race_events' && q.action === 'update')
    expect(update.payload.series_id).toBe('d0000000-0000-4000-8000-0000000000d1')
  })
  it('refuses a series that belongs to another host (400 invalid_series), writing nothing', async () => {
    db = fakeDb((q) => {
      if (q.table === 'race_events' && q.action === 'select') return { data: row, error: null }
      if (q.table === 'event_series') return { data: { id: 'S9', host_id: 'h2' }, error: null }
      return { data: null, error: null }
    })
    const res = await put({ ...BODY, series_id: 'd0000000-0000-4000-8000-0000000000d9' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_series')
    expect(db.queries.some((q) => q.action === 'update')).toBe(false)
    expect(syncEventSessions).not.toHaveBeenCalled()
  })
  it('a refused sync is 409 with the lib\'s message, and the event row is NOT written (no review stamp)', async () => {
    judgeSessions.mockResolvedValue({ ok: false, error: 'session_has_entries', session_time: '10:00', message: 'The 10:00 session has bookings, so it cannot be removed.' })
    const res = await put({ ...BODY, sessions: [{ start_time: '12:00', capacity: 5 }] })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j).toMatchObject({ success: false, error: 'session_has_entries' })
    expect(j.message).toMatch(/10:00/)
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
    expect(syncEventSessions).not.toHaveBeenCalled()
  })
  it('a swap refused by the judge never stamps a published event back to review', async () => {
    judgeSessions.mockResolvedValue({ ok: false, error: 'duplicate_session_time', message: 'Two sessions would share a start time.' })
    const res = await put({ ...BODY, sessions: [{ id: W1, start_time: '14:00', capacity: 20 }, { start_time: '10:00', capacity: 5 }] })
    expect(res.status).toBe(409)
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
  })
  it('400 on the retired single-session keys', async () => {
    const res = await put({ ...BODY, session_capacity: 20 })
    expect(res.status).toBe(400)
  })
})

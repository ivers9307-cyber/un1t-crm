// HOSTSERIES.1 — POST /api/host/events writes the event, then every session
// through syncEventSessions (one call, currentWaves empty).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let session
let db
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-slug', async (importOriginal) => ({ ...(await importOriginal()), uniqueEventSlug: vi.fn(async (_db, base) => base) }))
vi.mock('@/lib/host-events', async (importOriginal) => ({ ...(await importOriginal()), ensureAnchorLocation: vi.fn(async () => 'L-anchor') }))
vi.mock('@/lib/event-sessions', async (importOriginal) => ({ ...(await importOriginal()), syncEventSessions: vi.fn() }))

const { syncEventSessions } = await import('@/lib/event-sessions')
const { POST } = await import('./route.js')

const BODY = {
  kind: 'workshop', name: 'Mobility', race_date: '2026-12-05', allowed_team_sizes: [1, 2],
  ticket_price_cents: 2500, venue_name: 'Studio 1',
  sessions: [{ start_time: '10:00', capacity: 20 }, { start_time: '14:00', label: 'Afternoon', capacity: 15 }],
}
const post = (body) => POST(new Request('https://crm.test/api/host/events', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  db = fakeDb((q) => {
    if (q.table === 'event_hosts') return { data: { id: 'h1', name: 'Run Club', organization_id: 'o1', anchor_location_id: 'L-anchor' }, error: null }
    if (q.table === 'race_events' && q.action === 'insert') return { data: { id: 'E-new', slug: q.payload.slug }, error: null }
    return { data: null, error: null }
  })
  syncEventSessions.mockResolvedValue({ ok: true, waves: [] })
})

describe('POST /api/host/events', () => {
  it('401 without a host session', async () => {
    session = null
    expect((await post(BODY)).status).toBe(401)
  })
  it('creates the event and syncs both sessions in ONE call', async () => {
    const res = await post(BODY)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ success: true, data: { id: 'E-new' } })
    expect(syncEventSessions).toHaveBeenCalledTimes(1)
    const [, args] = syncEventSessions.mock.calls[0]
    expect(args).toMatchObject({ eventId: 'E-new', currentWaves: [] })
    expect(args.sessions.map((s) => s.start_time)).toEqual(['10:00', '14:00'])
    const insert = db.queries.find((q) => q.table === 'race_events' && q.action === 'insert')
    expect(insert.payload).toMatchObject({ status: 'draft', non_member_fee_cents: 2500, host_id: 'h1', location_id: 'L-anchor' })
    expect(insert.payload.slug).toMatch(/1000$/) // the FIRST session's time names the slug
  })
  it('400 on the retired single-session keys', async () => {
    const res = await post({ ...BODY, session_start_time: '10:00' })
    expect(res.status).toBe(400)
    expect(syncEventSessions).not.toHaveBeenCalled()
  })
  it('a refused session sync deletes the new event and answers 409 with the message', async () => {
    syncEventSessions.mockResolvedValue({ ok: false, error: 'duplicate_session_time', message: 'Two sessions would share a start time.' })
    const res = await post(BODY)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/share a start time/)
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'delete')).toBe(true)
  })
})

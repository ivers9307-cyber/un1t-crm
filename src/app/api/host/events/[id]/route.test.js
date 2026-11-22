// HOSTSERIES.1 — GET/PUT /api/host/events/[id] with sessions[]: the GET
// hands the form HH:MM sessions; the PUT answers 409 when the sync refuses.
// HOSTAUTOPUB.1 — the PUT never changes the status (no re-review).
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
vi.mock('@/lib/event-venue-studio', async (importOriginal) => ({ ...(await importOriginal()), judgeVenueStudio: vi.fn(async (_db, { venueLocationId }) => ({ ok: true, venueLocationId: venueLocationId ?? null })) }))

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
  it('returns registration_questions, and PUT writes them', async () => {
    row.registration_questions = [{ id: 'q-diet', label: 'Dietary needs', type: 'text', required: false, per: 'person' }]
    const j = await (await GET(new Request('https://crm.test'), props())).json()
    expect(j.data.registration_questions).toEqual(row.registration_questions)
    const res = await put({ ...BODY, registration_questions: [{ id: 'q-size', label: 'Size', type: 'text', required: false, per: 'entry' }] })
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published' } })
    expect(db.queries.find((q) => q.table === 'race_events' && q.action === 'update').payload.registration_questions).toEqual([{ id: 'q-size', label: 'Size', type: 'text', required: false, per: 'entry' }])
  })
  it('returns duration_minutes and PUT writes it', async () => {
    row.duration_minutes = 90
    const j = await (await GET(new Request('https://crm.test'), props())).json()
    expect(j.data.duration_minutes).toBe(90)
    await put({ ...BODY, duration_minutes: 45 })
    expect(db.queries.find((q) => q.table === 'race_events' && q.action === 'update').payload.duration_minutes).toBe(45)
  })
  it('returns pricing_tiers', async () => {
    row.pricing_tiers = [{ id: 'a', name: 'Early bird', price_cents: 2500, capacity: 20 }]
    const j = await (await GET(new Request('https://crm.test'), props())).json()
    expect(j.data.pricing_tiers).toEqual(row.pricing_tiers)
  })
})

describe('PUT /api/host/events/[id]', () => {
  it('adding a session to a published event keeps it published and syncs both', async () => {
    const res = await put({ ...BODY, sessions: [...BODY.sessions, { start_time: '14:00', capacity: 10 }] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published' } })
    expect(syncEventSessions).toHaveBeenCalledTimes(1)
    expect(syncEventSessions.mock.calls[0][1]).toMatchObject({ eventId: E1, currentWaves: row.race_waves })
    expect(syncEventSessions.mock.calls[0][1].sessions).toHaveLength(2)
  })
  // HOSTAUTOPUB.1 — every edit that used to send a published event back to
  // review now applies straight away and leaves it published.
  const MATERIAL_EDITS = [
    ['the existing session\'s time', { sessions: [{ id: W1, start_time: '11:00', capacity: 20 }] }],
    ['the price', { ticket_price_cents: 3000 }],
    ['the date', { race_date: '2026-12-12' }],
    ['a pricing tier', { pricing_tiers: [{ id: 'a', name: 'Early bird', price_cents: 2500, capacity: 20 }] }],
    ['a longer duration', { duration_minutes: 600 }],
    ['a new session outside the old hours', { sessions: [...BODY.sessions, { start_time: '20:00', capacity: 10 }] }],
    // SHELLYEVENTS.1's studio move: now live at once (the studio's Shelly
    // timers follow the link). The org check still runs first.
    ['the studio it is held at', { venue_location_id: 'a0000000-0000-4000-8000-0000000000a1' }],
  ]
  for (const [what, patch] of MATERIAL_EDITS) {
    it(`changing ${what} on a published event keeps it published, with no review stamp`, async () => {
      const res = await put({ ...BODY, ...patch })
      expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published' } })
      const update = db.queries.find((q) => q.table === 'race_events' && q.action === 'update')
      expect(update.payload).not.toHaveProperty('status')
      expect(update.payload).not.toHaveProperty('submitted_at')
      expect(update.payload).not.toHaveProperty('reviewed_at')
    })
  }
  it('a tier change writes the tiers', async () => {
    await put({ ...BODY, pricing_tiers: [{ id: 'a', name: 'Early bird', price_cents: 2500, capacity: 20 }] })
    const update = db.queries.find((q) => q.table === 'race_events' && q.action === 'update')
    expect(update.payload.pricing_tiers).toEqual([{ id: 'a', name: 'Early bird', price_cents: 2500, capacity: 20 }])
  })
  it('a studio move is still judged against the host\'s organisation and refused when not one of its studios', async () => {
    const { judgeVenueStudio } = await import('@/lib/event-venue-studio')
    judgeVenueStudio.mockResolvedValueOnce({ ok: false, error: 'invalid_venue_studio' })
    const res = await put({ ...BODY, venue_location_id: 'a0000000-0000-4000-8000-0000000000a9' })
    expect(res.status).toBe(400)
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
  })
  it('a draft stays a draft on save (saving never publishes)', async () => {
    row.status = 'draft'
    const res = await put({ ...BODY, ticket_price_cents: 3000 })
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'draft' } })
    expect(db.queries.find((q) => q.table === 'race_events' && q.action === 'update').payload).not.toHaveProperty('status')
  })
  it('the host-only levers stay out of the write: the strict schema refuses them (400)', async () => {
    for (const key of ['member_pricing_enabled', 'create_in_glofox', 'shared', 'members_only', 'active', 'status']) {
      const res = await put({ ...BODY, [key]: true })
      expect(res.status, key).toBe(400)
    }
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
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
  it('a refused sync is 409 with the lib\'s message, and the event row is NOT written', async () => {
    judgeSessions.mockResolvedValue({ ok: false, error: 'session_has_entries', session_time: '10:00', message: 'The 10:00 session has bookings, so it cannot be removed.' })
    const res = await put({ ...BODY, sessions: [{ start_time: '12:00', capacity: 5 }] })
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j).toMatchObject({ success: false, error: 'session_has_entries' })
    expect(j.message).toMatch(/10:00/)
    expect(db.queries.some((q) => q.table === 'race_events' && q.action === 'update')).toBe(false)
    expect(syncEventSessions).not.toHaveBeenCalled()
  })
  it('a swap refused by the judge never writes the event row', async () => {
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

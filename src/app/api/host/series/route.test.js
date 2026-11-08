// HOSTSERIES.1 — GET /api/host/series (the host's own) and
// PATCH /api/host/series/[id] (copy edits; own series or 404).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const S1 = 'd0000000-0000-4000-8000-0000000000d1'
let session
let db
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/location-time', async (importOriginal) => ({ ...(await importOriginal()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))
vi.mock('@/lib/event-series', async (importOriginal) => ({ ...(await importOriginal()), listHostSeries: vi.fn() }))

const { listHostSeries } = await import('@/lib/event-series')
const { GET } = await import('./route.js')
const { PATCH } = await import('./[id]/route.js')

const props = () => ({ params: Promise.resolve({ id: S1 }) })
const patch = (body) => PATCH(new Request(`https://crm.test/api/host/series/${S1}`, { method: 'PATCH', body: JSON.stringify(body) }), props())

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club', anchor_location_id: 'L1' } }
  db = fakeDb((q) => (q.table === 'event_series' && q.action === 'select' ? { data: { id: S1, host_id: 'h1' }, error: null } : { data: null, error: null }))
  listHostSeries.mockResolvedValue([{ id: S1, name: 'Monthly', slug: 'monthly', headline: null, blurb: null, upcoming_count: 2 }])
})

describe('GET /api/host/series', () => {
  it('401 without a session; lists the host\'s series otherwise', async () => {
    session = null
    expect((await GET(new Request('https://crm.test'))).status).toBe(401)
    session = { host: { id: 'h1', anchor_location_id: 'L1' } }
    const res = await GET(new Request('https://crm.test'))
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([{ id: S1, name: 'Monthly', slug: 'monthly', headline: null, blurb: null, upcoming_count: 2 }])
    expect(listHostSeries).toHaveBeenCalledWith(db, expect.objectContaining({ hostId: 'h1' }))
  })
})

describe('PATCH /api/host/series/[id]', () => {
  it('404 for another host\'s series', async () => {
    db = fakeDb(() => ({ data: { id: S1, host_id: 'h2' }, error: null }))
    expect((await patch({ headline: 'Hi' })).status).toBe(404)
  })
  it('trims copy, turns empty strings into NULL, and writes only the given keys', async () => {
    const res = await patch({ headline: '  Pick your month  ', blurb: '' })
    expect(res.status).toBe(200)
    const upd = db.queries.find((q) => q.action === 'update')
    expect(upd.payload).toEqual({ headline: 'Pick your month', blurb: null })
    expect(upd.ops).toContainEqual(['eq', 'id', S1])
  })
  it('a rename alone writes only the name: headline and blurb are untouched', async () => {
    const res = await patch({ name: 'Monthly Mobility' })
    expect(res.status).toBe(200)
    const upd = db.queries.find((q) => q.action === 'update')
    expect(upd.payload).toEqual({ name: 'Monthly Mobility' })
  })
  it('400 for an over-long headline or an empty name', async () => {
    expect((await patch({ headline: 'x'.repeat(121) })).status).toBe(400)
    expect((await patch({ name: '' })).status).toBe(400)
  })
})

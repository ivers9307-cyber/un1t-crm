// HOSTSERIES.1 — POST /api/host/events/[id]/duplicate: a host copies ONE of
// their own events to a new date (404 for anyone else's).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
let session
let db
let row
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-duplicate', async (importOriginal) => ({ ...(await importOriginal()), duplicateEvent: vi.fn() }))

const { duplicateEvent } = await import('@/lib/event-duplicate')
const { POST } = await import('./route.js')

const props = () => ({ params: Promise.resolve({ id: E1 }) })
const post = (body) => POST(new Request(`https://crm.test/api/host/events/${E1}/duplicate`, { method: 'POST', body: JSON.stringify(body) }), props())

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  row = { id: E1, host_id: 'h1' }
  db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : { data: null, error: null }))
  duplicateEvent.mockResolvedValue({ ok: true, event: { id: 'E-new', slug: 'studio-1-dec12-1000' } })
})

describe('POST /api/host/events/[id]/duplicate', () => {
  it('401 without a host session', async () => {
    session = null
    expect((await post({ race_date: '2026-12-12' })).status).toBe(401)
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('404 for another host\'s event', async () => {
    row.host_id = 'h2'
    expect((await post({ race_date: '2026-12-12' })).status).toBe(404)
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('400 for a bad date', async () => {
    expect((await post({ race_date: '12/12/2026' })).status).toBe(400)
    expect(duplicateEvent).not.toHaveBeenCalled()
  })
  it('copies the event and answers its id and slug', async () => {
    const res = await post({ race_date: '2026-12-12' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 'E-new', slug: 'studio-1-dec12-1000' } })
    expect(duplicateEvent).toHaveBeenCalledWith(db, { sourceId: E1, raceDate: '2026-12-12' })
  })
  it('a failed copy is 500 with the lib\'s message', async () => {
    duplicateEvent.mockResolvedValue({ ok: false, error: 'write_failed', message: 'The copy could not be saved.' })
    const res = await post({ race_date: '2026-12-12' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/could not be saved/)
  })
})

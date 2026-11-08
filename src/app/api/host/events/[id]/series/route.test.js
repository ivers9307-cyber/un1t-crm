// HOSTSERIES.1 — POST /api/host/events/[id]/series: make one of the host's
// own events the first date of a new series (one draft copy per other date).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
let session
let db
let row
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/event-series', async (importOriginal) => ({ ...(await importOriginal()), createSeriesFromEvent: vi.fn() }))

const { createSeriesFromEvent } = await import('@/lib/event-series')
const { POST } = await import('./route.js')

const props = () => ({ params: Promise.resolve({ id: E1 }) })
const post = (body) => POST(new Request(`https://crm.test/api/host/events/${E1}/series`, { method: 'POST', body: JSON.stringify(body) }), props())

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Run Club' } }
  row = { id: E1, host_id: 'h1' }
  db = fakeDb((q) => (q.table === 'race_events' ? { data: row, error: null } : { data: null, error: null }))
  createSeriesFromEvent.mockResolvedValue({ ok: true, series: { id: 'S1', slug: 'monthly' }, created: [{ id: 'E2', slug: 'x', race_date: '2027-01-02' }] })
})

describe('POST /api/host/events/[id]/series', () => {
  it('401 / 404 fences', async () => {
    session = null
    expect((await post({ name: 'Monthly', dates: ['2027-01-02'] })).status).toBe(401)
    session = { host: { id: 'h1' } }
    row.host_id = 'h2'
    expect((await post({ name: 'Monthly', dates: ['2027-01-02'] })).status).toBe(404)
    expect(createSeriesFromEvent).not.toHaveBeenCalled()
  })
  it('400 for a bad body (no dates, a bad date, no name)', async () => {
    expect((await post({ name: 'Monthly', dates: [] })).status).toBe(400)
    expect((await post({ name: 'Monthly', dates: ['2/1/2027'] })).status).toBe(400)
    expect((await post({ name: '', dates: ['2027-01-02'] })).status).toBe(400)
  })
  it('makes the series and answers it with the copies', async () => {
    const res = await post({ name: 'Monthly', dates: ['2027-01-02'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { series: { id: 'S1', slug: 'monthly' }, created: [{ id: 'E2', slug: 'x', race_date: '2027-01-02' }] } })
    expect(createSeriesFromEvent).toHaveBeenCalledWith(db, { sourceId: E1, dates: ['2027-01-02'], name: 'Monthly' })
  })
  it('409 already_in_series, 400 invalid_dates, 500 write_failed with the copies so far', async () => {
    createSeriesFromEvent.mockResolvedValueOnce({ ok: false, error: 'already_in_series', message: 'Already in a series.' })
    expect((await post({ name: 'Monthly', dates: ['2027-01-02'] })).status).toBe(409)
    createSeriesFromEvent.mockResolvedValueOnce({ ok: false, error: 'invalid_dates', message: 'Pick other dates.' })
    expect((await post({ name: 'Monthly', dates: ['2027-01-02'] })).status).toBe(400)
    createSeriesFromEvent.mockResolvedValueOnce({ ok: false, error: 'write_failed', message: 'Made 1 of 3.', created: [{ id: 'E2' }] })
    const res = await post({ name: 'Monthly', dates: ['2027-01-02'] })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, error: 'write_failed', message: 'Made 1 of 3.', created: [{ id: 'E2' }] })
  })
})

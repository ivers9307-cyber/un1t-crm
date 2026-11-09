// HOSTPORTAL.4 — POST /api/host/events/[id]/announce-draft: a draft email
// about the host's own on-sale event. Never sends; never for another host's
// event or one that is not on sale.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

let db
let session
let event
let insertError
let today
let existingDrafts
let lookupError
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://studio.test/some/path') }))
vi.mock('@/lib/host-portal', async (orig) => ({ ...(await orig()), loadHostToday: vi.fn(async () => ({ zone: 'Europe/Dublin', today })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const { POST } = await import('./route.js')

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const post = () => POST(new Request(`https://crm.test/api/host/events/${E1}/announce-draft`, { method: 'POST' }), { params: Promise.resolve({ id: E1 }) })
const inserts = () => db.queries.filter((q) => q.action === 'insert')

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: 'h1', name: 'Acme' } }
  insertError = null
  today = '2026-11-01'
  existingDrafts = []
  lookupError = null
  event = {
    id: E1, host_id: 'h1', name: 'Summer Run', slug: 'summer-run', status: 'published', active: true,
    race_date: '2026-11-14', venue_name: 'Phoenix Park',
    race_waves: [{ start_time: '10:30:00', label: 'Late', display_order: 2 }, { start_time: '09:00:00', label: 'Early', display_order: 1 }],
  }
  db = fakeDb((q) => {
    if (q.table === 'race_events') return { data: event, error: null }
    if (q.table === 'event_hosts') return { data: { anchor_location_id: 'loc1' }, error: null }
    if (q.table === 'host_campaigns' && q.action === 'select') return lookupError ? { data: null, error: lookupError } : { data: existingDrafts, error: null }
    if (q.table === 'host_campaigns' && q.action === 'insert') return insertError ? { data: null, error: insertError } : { data: { id: 'c1' }, error: null }
    return { data: null, error: null }
  })
})

describe('POST /api/host/events/[id]/announce-draft', () => {
  it("401s without a session; 404s for another host's event and inserts nothing", async () => {
    session = null
    expect((await post()).status).toBe(401)
    expect(inserts()).toHaveLength(0)
    session = { host: { id: 'h1' } }
    event = { ...event, host_id: 'h2' }
    const res = await post()
    expect(res.status).toBe(404)
    expect(inserts()).toHaveLength(0)
  })

  it('404s for a missing event and inserts nothing', async () => {
    event = null
    expect((await post()).status).toBe(404)
    expect(inserts()).toHaveLength(0)
  })

  it('409s with the reason that fits the event and inserts nothing', async () => {
    const cases = [
      [{ status: 'draft' }, 'Publish this event before emailing your list about it.'],
      [{ status: 'rejected' }, 'Publish this event before emailing your list about it.'],
      [{ status: 'pending_review' }, 'This event is waiting for approval. You can email your list once it is on sale.'],
      [{ active: false }, 'This event is off sale. Put it back on sale before emailing your list about it.'],
    ]
    for (const [patch, error] of cases) {
      db.queries.length = 0
      event = { ...event, status: 'published', active: true, ...patch }
      const res = await post()
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ success: false, error })
      expect(inserts()).toHaveLength(0)
    }
  })

  it('409s for an event that has already taken place (race_date before today on the host clock) and inserts nothing', async () => {
    today = '2026-11-15'
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'This event has already taken place.' })
    expect(inserts()).toHaveLength(0)
    today = '2026-11-14'
    expect((await post()).status).toBe(201)
  })

  it('inserts one draft for this host with audience all, type marketing, status draft and no design_json', async () => {
    const res = await post()
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, data: { id: 'c1' } })
    expect(inserts()).toHaveLength(1)
    const row = inserts()[0].payload
    expect(row).toMatchObject({
      host_id: 'h1', subject: 'Summer Run', audience_kind: 'all', audience_event_id: null, audience_campaign_id: null,
      email_type: 'marketing', status: 'draft',
    })
    expect(row).not.toHaveProperty('design_json')
    expect(row.body_html).toContain('Saturday 14 November 2026')
    expect(row.body_html.indexOf('09:00')).toBeLessThan(row.body_html.indexOf('10:30'))
    expect(row.body_html).toContain('<a href="https://studio.test/event/summer-run">Book your place</a>')
    expect(db.queries.find((q) => q.table === 'event_hosts').ops).toEqual(expect.arrayContaining([['eq', 'id', 'h1']]))
  })

  it('answers 500 with the message when the insert fails', async () => {
    insertError = { message: 'insert exploded' }
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'insert exploded' })
  })

  it('answers 500 and inserts nothing when the event link cannot be built', async () => {
    event = { ...event, slug: null }
    const res = await post()
    expect(res.status).toBe(500)
    expect(inserts()).toHaveLength(0)
  })

  it('hands back the first draft and inserts nothing when the same draft already exists', async () => {
    existingDrafts = [{ id: 'c0' }]
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 'c0' } })
    expect(inserts()).toHaveLength(0)
    const lookup = db.queries.find((q) => q.table === 'host_campaigns' && q.action === 'select')
    expect(lookup.ops).toEqual(expect.arrayContaining([
      ['select', 'id'], ['eq', 'host_id', 'h1'], ['eq', 'status', 'draft'], ['eq', 'subject', 'Summer Run'], ['limit', 1],
    ]))
    expect(lookup.ops.find((o) => o[1] === 'body_html')[2]).toContain('Book your place')
  })

  it('makes a new draft when the host edited the earlier one (no row matches)', async () => {
    existingDrafts = []
    const res = await post()
    expect(res.status).toBe(201)
    expect(inserts()).toHaveLength(1)
  })

  it('inserts as before when the duplicate lookup fails', async () => {
    lookupError = { message: 'read failed' }
    const res = await post()
    expect(res.status).toBe(201)
    expect(inserts()).toHaveLength(1)
  })
})

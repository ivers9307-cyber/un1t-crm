// HOSTAUTOPUB.1 — POST /api/host/events/[id]/submit publishes the host's event
// straight away (no pending_review, no approval item) and tells the org's
// admins with a notice.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'

const E1 = 'e0000000-0000-4000-8000-0000000000e1'
const H1 = 'b0000000-0000-4000-8000-0000000000b1'
const H2 = 'b0000000-0000-4000-8000-0000000000b2'
const ORG = 'c0000000-0000-4000-8000-0000000000c1'
const ANCHOR = 'a0000000-0000-4000-8000-0000000000a1'
let session
let db

vi.mock('@/lib/host-auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentHost: vi.fn(async () => session) }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => db) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/host-notifications', async (importOriginal) => ({ ...(await importOriginal()), notifyAdminsEventPublished: vi.fn(async () => {}) }))
vi.mock('@/lib/push-dedup', async (importOriginal) => ({ ...(await importOriginal()), sendPushOnce: vi.fn(async () => ({ ok: true })) }))

const { notifyAdminsEventPublished } = await import('@/lib/host-notifications')
const { sendPushOnce } = await import('@/lib/push-dedup')
const { eventIsPublic } = await import('@/lib/host-events')
const { POST } = await import('./route.js')

const call = () => POST(new Request(`https://crm.test/api/host/events/${E1}/submit`, { method: 'POST' }), { params: Promise.resolve({ id: E1 }) })
const eventRow = () => db.tables.race_events.find((r) => r.id === E1)

function seed(status, extra = {}) {
  db = createFakeDb({
    tables: {
      race_events: [{
        id: E1, host_id: H1, status, name: 'Mobility', slug: 'studio-1-dec05-1000', location_id: ANCHOR, active: true,
        rejected_reason: status === 'rejected' ? 'Wrong venue' : null, submitted_at: null, reviewed_at: null,
        member_pricing_enabled: false, create_in_glofox: false, shared: false, members_only: false,
        ...extra,
      }],
      event_hosts: [{ id: H1, name: 'Run Club', email: 'host@example.com', organization_id: ORG }],
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  session = { host: { id: H1, name: 'Run Club', organization_id: ORG } }
  seed('draft')
})

describe('POST /api/host/events/[id]/submit (HOSTAUTOPUB.1)', () => {
  it('publishes a draft straight away; it is public when active', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: E1, status: 'published' } })
    const row = eventRow()
    expect(row.status).toBe('published')
    expect(row.submitted_at).toBeTruthy()
    expect(row.reviewed_at).toBeNull()
    expect(eventIsPublic(row)).toBe(true)
  })

  it('one write, guarded on the status it read, and never to pending_review', async () => {
    await call()
    const writes = db.calls.filter((c) => c.table === 'race_events' && c.op === 'update')
    expect(writes).toHaveLength(1)
    expect(writes[0].filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'id', op: 'eq', value: E1 }),
      expect.objectContaining({ column: 'status', op: 'eq', value: 'draft' }),
    ]))
    expect(eventRow().status).not.toBe('pending_review')
  })

  it('an inactive event is published but stays off the public pages (visibility unchanged)', async () => {
    seed('draft', { active: false })
    await call()
    expect(eventRow().status).toBe('published')
    expect(eventIsPublic(eventRow())).toBe(false)
  })

  it('publishes a row left rejected (clearing the reason) or pending_review from before', async () => {
    seed('rejected')
    await call()
    expect(eventRow()).toMatchObject({ status: 'published', rejected_reason: null })
    seed('pending_review')
    await call()
    expect(eventRow().status).toBe('published')
  })

  it('leaves the UN1T-only levers as they were (the route writes only status fields)', async () => {
    await call()
    expect(eventRow()).toMatchObject({ member_pricing_enabled: false, create_in_glofox: false, shared: false, members_only: false })
  })

  it('tells the admins with the informational notice, carrying this publish\'s time', async () => {
    await call()
    expect(notifyAdminsEventPublished).toHaveBeenCalledTimes(1)
    const arg = notifyAdminsEventPublished.mock.calls[0][0]
    expect(arg.orgId).toBe(ORG)
    expect(arg.host).toMatchObject({ id: H1, name: 'Run Club' })
    expect(arg.event).toMatchObject({ id: E1, name: 'Mobility' })
    expect(arg.event.submitted_at).toBe(eventRow().submitted_at)
  })

  it('a notify failure never changes the answer', async () => {
    notifyAdminsEventPublished.mockRejectedValueOnce(new Error('postmark down'))
    const res = await call()
    expect(res.status).toBe(200)
    expect(eventRow().status).toBe('published')
  })

  it('sends no approval push of its own', async () => {
    await call()
    expect(sendPushOnce).not.toHaveBeenCalled()
  })

  it('409 for an event that is already published, writing nothing', async () => {
    seed('published')
    const res = await call()
    expect(res.status).toBe(409)
    expect(db.calls.some((c) => c.op === 'update')).toBe(false)
    expect(notifyAdminsEventPublished).not.toHaveBeenCalled()
  })

  it('404 for another host\'s event, 401 signed out', async () => {
    session = { host: { id: H2, name: 'Other', organization_id: ORG } }
    expect((await call()).status).toBe(404)
    session = null
    expect((await call()).status).toBe(401)
    expect(eventRow().status).toBe('draft')
  })
})

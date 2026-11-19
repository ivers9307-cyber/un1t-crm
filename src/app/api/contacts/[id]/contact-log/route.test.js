// CONTACTLOG.1 — POST /api/contacts/[id]/contact-log logs a contact on the timeline, under
// the task form's rule: the web Tasks key AND Contacts at the body's studio,
// that studio's membership first, and the contact must be AT that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'
import { POST } from './route.js'

const C1 = 'c1000000-0000-4000-8000-000000000001'
const req = (body) => new Request('http://localhost/api/contacts/x/contact-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const props = (id = C1) => ({ params: Promise.resolve({ id }) })

const WEB_ONLY = person({ [LOC_B]: { role: 'staff', permissions: { activities: true, contacts: true, mobile: { tasks: false, pipeline: false, contacts: false } } } }, LOC_B)
const NO_TASKS_B = person({ [LOC_A]: { role: 'owner' }, [LOC_B]: { role: 'owner', permissions: { activities: false } } }, LOC_A)
const OUTSIDER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)

let db
beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(WEB_ONLY)
  db = createFakeDb({ tables: { contacts: [{ id: C1, location_id: LOC_B }], contact_studios: [], activities: [] } })
  createServerClient.mockImplementation(() => db)
})

describe('POST /api/contacts/[id]/contact-log', () => {
  it('logs a contact event at the studio, channel and outcome as the subject', async () => {
    const res = await POST(req({ location_id: LOC_B, channel: 'whatsapp', outcome: 'no_reply', note: '  sent twice ' }), props())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { subject: 'WhatsApp: no reply' } })
    expect(db.tables.activities).toHaveLength(1)
    expect(db.tables.activities[0]).toMatchObject({
      type: 'contact_log', kind: 'event', done: true, source: 'crm',
      contact_id: C1, location_id: LOC_B, subject: 'WhatsApp: no reply', note: 'sent twice',
    })
    expect(typeof db.tables.activities[0].completed_at).toBe('string')
  })

  it('an unknown channel or outcome is a 400 and writes nothing', async () => {
    const res = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'maybe' }), props())
    expect(res.status).toBe(400)
    const res2 = await POST(req({ location_id: LOC_B, channel: 'pigeon', outcome: 'reached' }), props())
    expect(res2.status).toBe(400)
    expect(db.tables.activities).toHaveLength(0)
  })

  it('no Tasks key at the body studio: 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(NO_TASKS_B)
    const res = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props())
    expect(res.status).toBe(403)
    expect(db.tables.activities).toHaveLength(0)
  })

  it('a studio the caller does not belong to: 403, nothing written', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    const res = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props())
    expect(res.status).toBe(403)
    expect(db.tables.activities).toHaveLength(0)
  })

  it('a contact at another studio, or none: 404 either way', async () => {
    db.tables.contacts[0].location_id = LOC_A
    const elsewhere = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props())
    expect(elsewhere.status).toBe(404)
    const missing = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props('c1000000-0000-4000-8000-000000000999'))
    expect(missing.status).toBe(404)
    const junk = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props('nope'))
    expect(junk.status).toBe(404)
    expect(db.tables.activities).toHaveLength(0)
  })

  it('signed out: 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req({ location_id: LOC_B, channel: 'call', outcome: 'reached' }), props())
    expect(res.status).toBe(401)
  })
})

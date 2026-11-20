// POST /api/contacts/[id]/inbody-sync through the real withAuth wrapper. The
// role and studio cases are tests/role-sweep/contact-detail.test.js; this file
// pins the signed-out answer, the happy path and the error text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const CONTACT = 'c1000000-0000-4000-8000-000000000001'
const coach = person({ [LOC_A]: { role: 'staff', permissions: { consultations: true } } }, LOC_A)
const sync = () => POST(new Request(`http://localhost/api/contacts/${CONTACT}/inbody-sync`, { method: 'POST' }), { params: Promise.resolve({ id: CONTACT }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    contacts: [{ id: CONTACT, location_id: LOC_A, phone: '+353870000001' }],
    inbody_backfill_requests: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/contacts/[id]/inbody-sync', () => {
  it('401 "Unauthorized" signed out (it said "Unauthorised")', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await sync()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.calls).toEqual([])
  })

  it('queues a backfill for the contact at its studio', async () => {
    getCurrentUser.mockResolvedValue(coach)
    const res = await sync()
    expect(res.status).toBe(200)
    expect(db.tables.inbody_backfill_requests).toEqual([expect.objectContaining({ contact_id: CONTACT, location_id: LOC_A, requested_by: 'user-1', status: 'pending' })])
  })

  it('a failed insert answers a fixed 500 with no database text or phone number', async () => {
    getCurrentUser.mockResolvedValue(coach)
    db.errors.inbody_backfill_requests = { insert: { message: 'Failing row contains (+353870000001, pending)' } }
    const res = await sync()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not queue the InBody sync. Try again.' })
  })
})

// GET /api/hosts/pending-events through the real withAuth wrapper:
// ADMIN_ROLES at the active studio; only this org's hosts' pending events.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const H1 = 'c0000000-0000-4000-8000-0000000000c1'
const H_OTHER = 'c0000000-0000-4000-8000-0000000000c2'
const get = () => GET(new Request('http://localhost/api/hosts/pending-events'))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      event_hosts: [
        { id: H1, organization_id: ORG, name: 'Host One' },
        { id: H_OTHER, organization_id: 'f0000000-0000-4000-8000-0000000000f9', name: 'Elsewhere' },
      ],
      locations: [],
      race_waves: [],
      race_events: [
        { id: 'e0000000-0000-4000-8000-0000000000e1', host_id: H1, name: 'Mine', status: 'pending_review', submitted_at: '2026-11-19T10:00:00Z' },
        { id: 'e0000000-0000-4000-8000-0000000000e2', host_id: H1, name: 'Live one', status: 'approved', submitted_at: '2026-11-18T10:00:00Z' },
        { id: 'e0000000-0000-4000-8000-0000000000e3', host_id: H_OTHER, name: 'Theirs', status: 'pending_review', submitted_at: '2026-11-19T11:00:00Z' },
      ],
    },
  }))
})

describe('GET /api/hosts/pending-events', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Manager+ required" for staff', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
  })

  it('a manager sees only their org’s pending events, with the host name', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.map((e) => [e.name, e.host_name])).toEqual([['Mine', 'Host One']])
  })
})

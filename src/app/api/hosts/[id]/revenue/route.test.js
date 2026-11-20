// EVENTS-HOST.8 — GET /api/hosts/[id]/revenue through the real withAuth
// wrapper: ADMIN_ROLES at the active studio, host in the caller's org.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, ORG } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/host-revenue', () => ({ getHostRevenue: vi.fn(async () => ({ grossCents: 1200, events: [] })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { getHostRevenue } = await import('@/lib/host-revenue')
const { GET } = await import('./route.js')

const H1 = 'c0000000-0000-4000-8000-0000000000c1'
const H_OTHER = 'c0000000-0000-4000-8000-0000000000c2'
const get = (id = H1) => GET(new Request(`http://localhost/api/hosts/${id}/revenue`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      event_hosts: [
        { id: H1, organization_id: ORG, name: 'Host One' },
        { id: H_OTHER, organization_id: 'f0000000-0000-4000-8000-0000000000f9', name: 'Elsewhere' },
      ],
    },
  }))
})

describe('GET /api/hosts/[id]/revenue', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Manager+ required" for a head coach', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'head_coach' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Manager+ required' })
    expect(getHostRevenue).not.toHaveBeenCalled()
  })

  it('404 "Host not found" for another org’s host', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get(H_OTHER)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'Host not found' })
  })

  it('an owner reads the rollup', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { grossCents: 1200, events: [] } })
    expect(getHostRevenue).toHaveBeenCalledWith(expect.anything(), H1)
  })
})

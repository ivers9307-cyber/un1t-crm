// SEC-LIVE-API.1 — POST /api/live/[locationId]/end-all through the real withAuth
// wrapper. gate.test.js sweeps the whole family; this pins the bodies: the
// guard's 403s are unchanged and judged at the URL's studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B, LOC_OTHER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/live-class', () => ({ endAllAtLocation: vi.fn(async () => ({ ended: 2 })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { endAllAtLocation } = await import('@/lib/live-class')
const { POST } = await import('./route.js')

const post = (locationId = LOC_B) => POST(new Request(`http://localhost/api/live/${locationId}/end-all`, { method: 'POST' }), { params: Promise.resolve({ locationId }) })
const studio = { studio_management: true }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: {} }))
})

describe('POST /api/live/[locationId]/end-all', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post()).status).toBe(401)
    expect(endAllAtLocation).not.toHaveBeenCalled()
  })

  it('403 "Location not in your scope" for a studio the caller does not hold', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner', permissions: studio } }, LOC_A))
    const res = await post(LOC_OTHER)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Location not in your scope' })
  })

  it('403 "Coach only" for staff at the URL studio, even as head coach at the active one', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'head_coach', permissions: studio }, [LOC_B]: { role: 'staff', permissions: studio } }, LOC_A))
    const res = await post(LOC_B)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Coach only' })
    expect(endAllAtLocation).not.toHaveBeenCalled()
  })

  it('a head coach with studio_management at the URL studio ends every session there', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' }, [LOC_B]: { role: 'head_coach', permissions: studio } }, LOC_A))
    const res = await post(LOC_B)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ended: 2 })
    expect(endAllAtLocation).toHaveBeenCalledWith(expect.anything(), LOC_B)
  })

  it('a master passes', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post(LOC_B)).status).toBe(200)
  })
})

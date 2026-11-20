// ROUTEWRAP.R10 — POST /api/live/[locationId]/pair through the real withAuth
// wrapper: signed out is the wrapper's 401; guardLiveLocation still judges the
// URL's studio, the coach roles and studio_management there.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logInfo: vi.fn() }))
vi.mock('@/lib/live-class', () => ({ pairOverride: vi.fn(async () => ({ ok: true, sessionId: 's1' })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { pairOverride } = await import('@/lib/live-class')
const { POST } = await import('./route.js')

const BODY = { device_key: 'ant:12345', contact_id: 'c1', bridge_id: 'b1' }
const post = (loc, body = BODY) => POST(new Request(`http://localhost/api/live/${loc}/pair`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ locationId: loc }) })
const at = (role, on = true) => person({ [LOC_A]: { role, permissions: { studio_management: on } } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('POST /api/live/[locationId]/pair', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post(LOC_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 at a studio outside the caller’s, for staff, and without studio_management', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    expect((await post(LOC_B)).status).toBe(403)
    getCurrentUser.mockResolvedValue(at('staff'))
    expect((await post(LOC_A)).status).toBe(403)
    getCurrentUser.mockResolvedValue(at('head_coach', false))
    expect((await post(LOC_A)).status).toBe(403)
    expect(pairOverride).not.toHaveBeenCalled()
  })

  it('pairs the strap at the URL’s studio', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    const res = await post(LOC_A)
    expect(await res.json()).toEqual({ ok: true, session_id: 's1' })
    expect(pairOverride).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ locationId: LOC_A, deviceKey: 'ant:12345', actorUserId: 'user-1' }))
  })
})

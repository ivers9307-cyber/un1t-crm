// ROUTEWRAP.R10 — POST /api/campaigns/[id]/send through the real withAuth
// wrapper and the real auth helpers: signed out is the wrapper's 401, another
// studio's campaign is 404, no email permission there is 403, and only then
// does the release run (route.test.js covers the wallet and cap rules).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/campaign-release', async (importOriginal) => ({
  ...(await importOriginal()),
  releasePreflight: vi.fn(async () => ({ ok: true })),
  releaseCampaign: vi.fn(async () => ({ ok: true })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { releasePreflight, releaseCampaign } = await import('@/lib/campaign-release')
const { POST } = await import('./route.js')

const C_A = 'c0000000-0000-4000-8000-0000000000a1'
const C_B = 'c0000000-0000-4000-8000-0000000000b1'
const send = (id) => POST(new Request(`http://localhost/api/campaigns/${id}/send`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const marketer = (on = true) => person({ [LOC_A]: { role: 'manager', permissions: { email: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: {
      campaigns: [
        { id: C_A, location_id: LOC_A, status: 'draft', name: 'A', subject: 'Hi', html_content: '<p>Hi</p>' },
        { id: C_B, location_id: LOC_B, status: 'draft', name: 'B', subject: 'Hi', html_content: '<p>Hi</p>' },
      ],
    },
  }))
})

describe('POST /api/campaigns/[id]/send — who may send', () => {
  it('401 signed out, nothing released', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await send(C_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(releaseCampaign).not.toHaveBeenCalled()
  })

  it('404 for another studio’s campaign', async () => {
    getCurrentUser.mockResolvedValue(marketer())
    const res = await send(C_B)
    expect(res.status).toBe(404)
    expect(releasePreflight).not.toHaveBeenCalled()
  })

  it('403 without email at the campaign’s studio', async () => {
    getCurrentUser.mockResolvedValue(marketer(false))
    const res = await send(C_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'No email permission at this location' })
    expect(releaseCampaign).not.toHaveBeenCalled()
  })

  it('queues the caller’s own studio’s campaign', async () => {
    getCurrentUser.mockResolvedValue(marketer())
    const res = await send(C_A)
    expect(await res.json()).toMatchObject({ success: true, queued: true })
    expect(releaseCampaign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: C_A, location_id: LOC_A }))
  })
})

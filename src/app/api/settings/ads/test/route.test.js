// ADS-REPORT.0 — POST /api/settings/ads/test through the real withAuth wrapper:
// signed in + a member of the body's studio, no permission key.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/ads/providers/meta', () => ({ testMetaConnection: vi.fn(async () => ({ success: true, name: 'Studio A Ads' })) }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { testMetaConnection } = await import('@/lib/ads/providers/meta')
const { POST } = await import('./route.js')

const post = (body) => POST(new Request('http://localhost/api/settings/ads/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({
    tables: { ad_accounts: [{ id: 'ad000000-0000-4000-8000-000000000001', location_id: LOC_A, provider: 'meta', access_token: 'tok', is_active: true }] },
  }))
})

describe('POST /api/settings/ads/test', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ locationId: LOC_A, provider: 'meta' })).status).toBe(401)
  })

  it('403 for a studio the caller is not assigned to', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_B]: { role: 'owner' } }, LOC_B))
    const res = await post({ locationId: LOC_A, provider: 'meta' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden — location not in your assignments' })
    expect(testMetaConnection).not.toHaveBeenCalled()
  })

  it('400 without a locationId', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    expect((await post({ provider: 'meta' })).status).toBe(400)
  })

  it('a member of the studio (any role) runs the probe', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A))
    const res = await post({ locationId: LOC_A, provider: 'meta' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, name: 'Studio A Ads' })
  })
})

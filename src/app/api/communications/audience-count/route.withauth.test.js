// ROUTEWRAP.R16 — POST /api/communications/audience-count through the real
// withAuth wrapper and the real studio check: signed in (the same 401), a
// studio the caller is in (403 otherwise), an invalid filter a readable 400.
// The counting itself is route.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/audience-filter', async (importOriginal) => ({ ...(await importOriginal()), applyAudienceFilterAsync: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { applyAudienceFilterAsync, InvalidAudienceFilterError } = await import('@/lib/audience-filter')
const { POST } = await import('./route.js')

const count = (body) => POST(new Request('http://localhost/api/communications/audience-count', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))
const staffAtA = () => person({ [LOC_A]: { role: 'staff' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { studio_contacts: [] } }))
})

describe('POST /api/communications/audience-count — the gate', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await count({ location_id: LOC_A })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 for a studio the caller is not in, nothing counted', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    expect((await count({ location_id: LOC_OTHER })).status).toBe(403)
    expect(applyAudienceFilterAsync).not.toHaveBeenCalled()
  })

  it("an invalid filter keeps its own words (400)", async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    applyAudienceFilterAsync.mockRejectedValueOnce(new InvalidAudienceFilterError('Unknown field: shoe_size'))
    const res = await count({ location_id: LOC_A, audience_filter: { logic: 'and', filters: [] } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unknown field: shoe_size')
  })

  it('any other failure is the same 400 with a fixed line', async () => {
    getCurrentUser.mockResolvedValue(staffAtA())
    applyAudienceFilterAsync.mockRejectedValueOnce(new Error('secret db text'))
    const res = await count({ location_id: LOC_A })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not count audience' })
  })
})

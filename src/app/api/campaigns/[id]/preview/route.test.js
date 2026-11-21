// /api/campaigns/[id]/preview through the real withAuth wrapper, which only
// signs the caller in. The campaign (404) and its studio (404, never 403) keep
// their order; a count that fails is a fixed 400 unless the filter itself is
// wrong (our own words).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/postmark', async (importOriginal) => ({ ...(await importOriginal()), buildAudienceQueryAsync: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { buildAudienceQueryAsync } = await import('@/lib/postmark')
const { InvalidAudienceFilterError } = await import('@/lib/audience-filter')
const { GET, POST } = await import('./route.js')

const CAMP_A = 'ca300000-0000-4000-8000-00000000000a'
const CAMP_B = 'ca300000-0000-4000-8000-00000000000b'
const STAFF_A = person({ [LOC_A]: { role: 'manager' } }, LOC_A)
const ctx = (id) => ({ params: Promise.resolve({ id }) })
const counted = (count, error = null) => ({ query: Promise.resolve({ count, error }) })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { campaigns: [
    { id: CAMP_A, location_id: LOC_A, audience_filter: { logic: 'and', filters: [] }, postmark_stream: 'broadcast' },
    { id: CAMP_B, location_id: LOC_B, audience_filter: { logic: 'and', filters: [] }, postmark_stream: 'broadcast' },
  ] } }))
  buildAudienceQueryAsync.mockResolvedValue(counted(12))
})

describe('/api/campaigns/[id]/preview', () => {
  it('401 signed out on both verbs', async () => {
    getCurrentUser.mockResolvedValue(null)
    for (const res of [await GET(new Request('http://localhost/x'), ctx(CAMP_A)), await POST(new Request('http://localhost/x', { method: 'POST' }), ctx(CAMP_A))]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    }
    expect(buildAudienceQueryAsync).not.toHaveBeenCalled()
  })

  it('404 for another studio’s campaign, nothing counted', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    expect((await GET(new Request('http://localhost/x'), ctx(CAMP_B))).status).toBe(404)
    expect(buildAudienceQueryAsync).not.toHaveBeenCalled()
  })

  it('counts the caller’s own campaign at its studio', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await GET(new Request('http://localhost/x'), ctx(CAMP_A))
    expect(await res.json()).toEqual({ success: true, audience_count: 12 })
    expect(buildAudienceQueryAsync.mock.calls[0][2]).toBe(LOC_A)
  })

  it('a wrong filter keeps its own words; database text is a fixed 400', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    buildAudienceQueryAsync.mockRejectedValueOnce(new InvalidAudienceFilterError('Unknown audience field: nope'))
    let res = await POST(new Request('http://localhost/x', { method: 'POST' }), ctx(CAMP_A))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Unknown audience field: nope' })

    buildAudienceQueryAsync.mockResolvedValueOnce(counted(null, { message: 'column contact_location_audience.x does not exist' }))
    res = await POST(new Request('http://localhost/x', { method: 'POST' }), ctx(CAMP_A))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not count the audience' })

    buildAudienceQueryAsync.mockRejectedValueOnce(new Error('tags read failed: permission denied for table tags'))
    res = await GET(new Request('http://localhost/x'), ctx(CAMP_A))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not count the audience' })
  })
})

// ROUTEWRAP.R10 — GET /api/admin/app-usage/[profileId] through the real
// withAuth wrapper: signed out is the wrapper's 401, a non-master is 403, and a
// person outside the report's scope is 404 (never confirmed).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/app-usage/scope', async (importOriginal) => ({ ...(await importOriginal()), loadUsageScope: vi.fn() }))
vi.mock('@/lib/app-usage/queries', async (importOriginal) => ({
  ...(await importOriginal()),
  readSummary: vi.fn(async () => []),
  readLastActive: vi.fn(async () => new Map()),
  readDay: vi.fn(async () => ({ sessions: [], visits: [] })),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { loadUsageScope } = await import('@/lib/app-usage/scope')
const { readSummary } = await import('@/lib/app-usage/queries')
const { GET } = await import('./route.js')

const PERSON = 'c0000000-0000-4000-8000-0000000000c1'
const get = (id = PERSON) => GET(new Request(`http://localhost/api/admin/app-usage/${id}`), { params: Promise.resolve({ profileId: id }) })
const owner = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const master = person({ [LOC_A]: { role: 'owner' } }, LOC_A, { isMaster: true, profileRole: 'master' })

beforeEach(() => {
  vi.clearAllMocks()
  loadUsageScope.mockResolvedValue({ staff: [{ id: PERSON, full_name: 'Someone' }] })
})

describe('GET /api/admin/app-usage/[profileId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 for an owner who is not a master', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const res = await get()
    expect(res.status).toBe(403)
    expect(loadUsageScope).not.toHaveBeenCalled()
  })

  it('404 for a person outside the scope, and for a malformed id', async () => {
    getCurrentUser.mockResolvedValue(master)
    loadUsageScope.mockResolvedValue({ staff: [] })
    expect((await get()).status).toBe(404)
    expect((await get('not-a-uuid')).status).toBe(404)
  })

  it('a master reads the person’s usage', async () => {
    getCurrentUser.mockResolvedValue(master)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(readSummary).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ profileIds: [PERSON] }))
  })
})

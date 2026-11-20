// GET /api/mobile/today-feed through the real withAuth wrapper: signed in (the
// phone's Bearer token resolves in getCurrentUser) with an active studio; the
// feed gates each source itself.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/today-feed-data', () => ({ fetchTodayFeed: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { fetchTodayFeed } = await import('@/lib/today-feed-data')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/mobile/today-feed'))
const coach = () => person({ [LOC_A]: { role: 'staff' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  fetchTodayFeed.mockResolvedValue([{ id: 'approvals', count: 2 }])
})

describe('GET /api/mobile/today-feed', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('400 with no active studio, no feed built', async () => {
    getCurrentUser.mockResolvedValue({ ...coach(), activeLocation: null })
    const res = await get()
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(fetchTodayFeed).not.toHaveBeenCalled()
  })

  it('a signed-in caller gets the same { rows } shape for the active studio', async () => {
    const user = coach()
    getCurrentUser.mockResolvedValue(user)
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { rows: [{ id: 'approvals', count: 2 }] } })
    expect(fetchTodayFeed).toHaveBeenCalledWith({ tag: 'db' }, user, LOC_A)
  })
})

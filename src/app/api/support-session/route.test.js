// GET /api/support-session through the real withAuth wrapper: the real
// session must be a master (an impersonating master passes too).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, LOC_A } from '../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/support-session', () => ({ getRecentSupportSessions: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { getRecentSupportSessions } = await import('@/lib/support-session')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/support-session'))
const owner = () => person({ [LOC_A]: { role: 'owner' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  getRecentSupportSessions.mockResolvedValue([{ id: 's1' }])
})

describe('GET /api/support-session', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for an owner who is not a master', async () => {
    getCurrentUser.mockResolvedValue(owner())
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(getRecentSupportSessions).not.toHaveBeenCalled()
  })

  it('a master, and a master impersonating an owner, read the last 25 sessions', async () => {
    for (const who of [MASTER, { ...owner(), impersonatingFrom: { id: MASTER.id } }]) {
      getCurrentUser.mockResolvedValue(who)
      const res = await get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, data: { sessions: [{ id: 's1' }] } })
    }
    expect(getRecentSupportSessions).toHaveBeenCalledWith({ tag: 'db' }, 25)
  })
})

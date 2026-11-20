// GET /api/mobile/checklists/today through the real withAuth wrapper: signed in
// (the phone's Bearer token resolves in getCurrentUser) with an active studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/checklist-instances', () => ({ resolveTodayInstances: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { resolveTodayInstances } = await import('@/lib/checklist-instances')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/mobile/checklists/today'))
const coach = () => person({ [LOC_A]: { role: 'staff' } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  resolveTodayInstances.mockResolvedValue([{ id: 'i1' }])
})

describe('GET /api/mobile/checklists/today', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('400 with no active studio, nothing generated', async () => {
    getCurrentUser.mockResolvedValue({ ...coach(), activeLocation: null })
    const res = await get()
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(resolveTodayInstances).not.toHaveBeenCalled()
  })

  it('a signed-in coach gets the same { instances } shape for the active studio', async () => {
    const user = coach()
    getCurrentUser.mockResolvedValue(user)
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { instances: [{ id: 'i1' }] } })
    expect(resolveTodayInstances).toHaveBeenCalledWith({ tag: 'db' }, {
      profile: { id: user.id, role: 'staff', location_role: 'staff' },
      location: user.activeLocation,
    })
  })
})

// GET /api/mobile/impersonate/users through the real withAuth wrapper: a
// master (or a master impersonating) only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

let db
const get = () => GET(new Request('http://localhost/api/mobile/impersonate/users'))

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { profiles: [
    { id: 'user-m', full_name: 'Master One', email: 'm@example.com', role: 'master', active: true },
    { id: 'p2', full_name: 'Coach Two', email: 'c2@example.com', role: 'staff', active: true },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('GET /api/mobile/impersonate/users', () => {
  it('401 signed out, nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.calls).toEqual([])
  })

  it("403 'Master only' for an owner, nothing read", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(db.calls).toEqual([])
  })

  it('a master is let through, and is left out of the list', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).users.map((u) => u.id)).toEqual(['p2'])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.profiles = { select: { message: 'secret detail' } }
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

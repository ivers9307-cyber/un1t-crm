// GET /api/impersonate/users through the real withAuth wrapper: a master, or a
// master viewing as someone; never the master themself, never a tombstone.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, MASTER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const P1 = 'a1000000-0000-4000-8000-000000000001'
const P2 = 'a1000000-0000-4000-8000-000000000002'
const profiles = () => [
  { id: MASTER.id, full_name: 'Master One', email: 'm@example.com', role: 'master', active: true, deleted_at: null },
  { id: P1, full_name: 'Coach Two', email: 'c2@example.com', role: 'staff', active: true, deleted_at: null },
  { id: P2, full_name: 'Gone', email: 'g@example.invalid', role: 'staff', active: false, deleted_at: '2026-10-01T00:00:00Z' },
]
const get = () => GET(new Request('http://localhost/api/impersonate/users'))

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(createFakeDb({ tables: { profiles: profiles(), profile_locations: [], locations: [] } }))
})

describe('GET /api/impersonate/users', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 "Master only" for an owner', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
  })

  it('a master gets everyone but themself and the tombstones', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).users.map((u) => u.id)).toEqual([P1])
  })

  it('a master viewing as someone keeps the picker, without the real master in it', async () => {
    getCurrentUser.mockResolvedValue({ ...person({ [LOC_A]: { role: 'staff' } }, LOC_A), id: P1, impersonatingFrom: { masterId: MASTER.id } })
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).users.map((u) => u.id)).toEqual([P1])
  })

  it('a failed read is a 500 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { profiles: profiles() }, errors: { profiles: { select: { message: 'secret detail' } } } }))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

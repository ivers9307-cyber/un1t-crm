// PATCH /api/admin/plans/[id] through the real withAuth wrapper: masters only,
// metadata only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, MASTER } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH } = await import('./route.js')

const PLAN = 'f1000000-0000-4000-8000-000000000001'
const MISSING = 'f1000000-0000-4000-8000-000000000009'
const rows = () => [{ id: PLAN, slug: 'starter', name: 'Starter', kind: 'base', active: true, sort: 1 }]
const patch = (body, id = PLAN) => PATCH(new Request(`http://localhost/api/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { plans: rows() } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/admin/plans/[id]', () => {
  it('401 signed out (withAuth; it said 403 before)', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await patch({ name: 'X' })).status).toBe(401)
  })

  it('403 "Master only" for an owner, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await patch({ name: 'X' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(db.tables.plans[0].name).toBe('Starter')
  })

  it('404 for a plan that does not exist or an id that is not one', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await patch({ name: 'X' }, MISSING)).status).toBe(404)
    expect((await patch({ name: 'X' }, 'nope')).status).toBe(404)
  })

  it('a master renames the plan', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await patch({ name: 'Starter Plus' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ id: PLAN, name: 'Starter Plus' })
  })
})

// POST /api/admin/plans/[id]/versions through the real withAuth wrapper:
// signed out 401 (was a 403), a non-master the same 403 'Master only', then
// the id, the body and the plan, as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const PLAN = '91000000-0000-4000-8000-000000000001'
const OWNER = person({ [LOC_A]: { role: 'owner' } }, LOC_A)
const BODY = { effective_from: '2027-01-01', price_cents: 9900 }
const post = (id = PLAN, body = BODY) => POST(new Request(`http://localhost/api/admin/plans/${id}/versions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { plans: [{ id: PLAN, slug: 'studio', kind: 'base' }], plan_versions: [] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/plans/[id]/versions', () => {
  it('401 signed out (withAuth; was a 403), nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.plan_versions).toEqual([])
  })

  it('403 "Master only" for an owner, nothing written', async () => {
    getCurrentUser.mockResolvedValue(OWNER)
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Master only' })
    expect(db.tables.plan_versions).toEqual([])
  })

  it('404 for an unknown plan', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post('91000000-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('a master adds a version', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    expect(db.tables.plan_versions).toHaveLength(1)
    expect(db.tables.plan_versions[0]).toMatchObject({ plan_id: PLAN, price_cents: 9900, currency: 'EUR', created_by: MASTER.id })
  })

  it('a failed insert answers a fixed 400, never the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.errors.plan_versions = { insert: { code: '23514', message: 'new row violates check constraint "plan_versions_currency_check"' } }
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Could not save the version. Check the numbers and try again.' })
  })
})

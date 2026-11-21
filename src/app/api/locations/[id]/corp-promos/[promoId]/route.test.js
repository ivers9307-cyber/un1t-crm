// PATCH/DELETE /api/locations/[id]/corp-promos/[promoId] through the real
// withAuth wrapper ('param' mode): signed in (the same 401), the PATH's studio
// one of the caller's (404), owner AT it, masters passing (403); the promo read
// by (id, location_id), so another studio's promo id is a 404 too.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { LOC_A, LOC_B, MASTER, OUTSIDER, STAFF_A_OWNER_B, MANAGER_A_STAFF_B } from '../../_role-gate-cases.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { PATCH, DELETE } = await import('./route.js')

const PROMO_B = 'b3000000-0000-4000-8000-0000000000b1'
const PROMO_A = 'b3000000-0000-4000-8000-0000000000a1'
const promo = (id, location_id, extra = {}) => ({
  id, location_id, key: `key-${id.slice(-2)}`, name: 'Corp', platform: 'un1t_online', credits: 3, expires_in_days: 30,
  live: false, tag: 'corp', lead_source: 'corp', kind: 'credits', ...extra,
})
const ctx = (id, promoId) => ({ params: Promise.resolve({ id, promoId }) })
const patch = (id, promoId, body) => PATCH(new Request(`http://localhost/api/locations/${id}/corp-promos/${promoId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), ctx(id, promoId))
const del = (id, promoId) => DELETE(new Request(`http://localhost/api/locations/${id}/corp-promos/${promoId}`, { method: 'DELETE' }), ctx(id, promoId))

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    corp_promos: [promo(PROMO_B, LOC_B), promo(PROMO_A, LOC_A)],
    corp_promo_claims: [],
  } })
  createServerClient.mockReturnValue(db)
})

describe('PATCH /api/locations/[id]/corp-promos/[promoId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await patch(LOC_B, PROMO_B, { name: 'New' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 for a studio the caller is not in', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await patch(LOC_B, PROMO_B, { name: 'New' })).status).toBe(404)
  })

  it('403 for a manager (not owner) at the path studio, judged there, not at the active one', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await patch(LOC_B, PROMO_B, { name: 'New' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Only owners and masters can change promos.' })
  })

  it("404 for another studio's promo id", async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    expect((await patch(LOC_B, PROMO_A, { name: 'New' })).status).toBe(404)
    expect(db.tables.corp_promos.find((p) => p.id === PROMO_A).name).toBe('Corp')
  })

  it('an owner at the path studio renames the promo', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await patch(LOC_B, PROMO_B, { name: 'New name' })
    expect(res.status).toBe(200)
    expect(db.tables.corp_promos.find((p) => p.id === PROMO_B).name).toBe('New name')
  })
})

describe('DELETE /api/locations/[id]/corp-promos/[promoId]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await del(LOC_B, PROMO_B)).status).toBe(401)
  })

  it('403 for a manager at the path studio; 404 outside it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    expect((await del(LOC_B, PROMO_B)).status).toBe(403)
    getCurrentUser.mockResolvedValue(OUTSIDER)
    expect((await del(LOC_B, PROMO_B)).status).toBe(404)
    expect(db.tables.corp_promos).toHaveLength(2)
  })

  it('a master deletes a switched-off promo with no claims', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await del(LOC_B, PROMO_B)
    expect(res.status).toBe(200)
    expect(db.tables.corp_promos.map((p) => p.id)).toEqual([PROMO_A])
  })

  it('a live promo is a 409, not deleted', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db.tables.corp_promos[0].live = true
    expect((await del(LOC_B, PROMO_B)).status).toBe(409)
    expect(db.tables.corp_promos).toHaveLength(2)
  })
})

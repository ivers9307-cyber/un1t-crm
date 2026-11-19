// OFFERSEDIT.1 — the offers editor API through the real withAuth wrapper.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET, POST } = await import('./route.js')
const { PATCH } = await import('./[offerId]/route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'b0000000-0000-0000-0000-000000000002'
const OFFER = 'c0000000-0000-0000-0000-000000000003'

const userAs = (role) => ({
  id: 'u1', role, profileRole: role,
  activeLocation: { id: L1, features: {} },
  activeAssignment: { role, permissions: { approvals_offer_purchases: true } },
  rolesByLocation: { [L1]: role },
  assignmentsByLocation: { [L1]: { role, permissions: { approvals_offer_purchases: true } } },
  locations: [{ id: L1, role, features: {} }],
})

function fakeDb({ studio = { id: L1, membership_source: 'un1t_online' }, offers = [], products = [], slugs = [] } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const c = { table, op: 'select', filters: [] }
      calls.push(c)
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k, v) => { c.filters.push([k, v]); return b },
        like: () => b,
        insert: (row) => { c.op = 'insert'; c.row = row; return b },
        update: (u) => { c.op = 'update'; c.row = u; return b },
        maybeSingle: async () => {
          if (table === 'locations') return { data: studio, error: null }
          if (c.op === 'insert') return { data: { id: OFFER, ...c.row }, error: null }
          const id = c.filters.find(([k]) => k === 'id')?.[1]
          const loc = c.filters.find(([k]) => k === 'location_id')?.[1]
          return { data: offers.find((o) => o.id === id && o.location_id === loc) || null, error: null }
        },
        then(res, rej) {
          let data = []
          if (table === 'sale_offers' && c.op === 'update') data = [{ id: OFFER, ...c.row }]
          else if (table === 'sale_offers' && slugs.length && c.filters.length === 1) data = slugs.map((slug) => ({ slug }))
          else if (table === 'sale_offers') data = offers
          if (table === 'un1t_products') data = products
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const req = (method, body) => new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
const ctx = (id = L1, offerId) => ({ params: Promise.resolve(offerId ? { id, offerId } : { id }) })
const NEW = { name: '20 + 5 Pack', category: 'class_pack', bonus_headline: '5 free', price_cents: 20000 }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(userAs('owner')) })

describe('GET', () => {
  it('lists the studio\'s offers with what stops each from selling, and who may edit', async () => {
    createServerClient.mockReturnValue(fakeDb({ offers: [{ id: OFFER, location_id: L1, category: 'class_pack', price_cents: 1000, un1t_product_id: 'p1' }], products: [{ un1t_id: 'p1', price_cents: 900 }] }))
    const body = await (await GET(req('GET'), ctx())).json()
    expect(body.data.offers[0].problems.map((p) => p.code)).toEqual(['price_mismatch'])
    expect(body.data.can_edit).toBe(true)
    expect(body.data.platform).toBe('un1t_online')
  })
  it('another studio is a 404', async () => {
    createServerClient.mockReturnValue(fakeDb())
    expect((await GET(req('GET'), ctx(L2))).status).toBe(404)
  })
  it('a manager reads but cannot edit', async () => {
    getCurrentUser.mockResolvedValue(userAs('manager'))
    createServerClient.mockReturnValue(fakeDb())
    expect((await (await GET(req('GET'), ctx())).json()).data.can_edit).toBe(false)
  })
})

describe('POST', () => {
  it('a manager cannot create', async () => {
    getCurrentUser.mockResolvedValue(userAs('manager'))
    createServerClient.mockReturnValue(fakeDb())
    expect((await POST(req('POST', NEW), ctx())).status).toBe(403)
  })
  it('an active un1t.online pack with no product is refused; as a draft it is saved', async () => {
    createServerClient.mockReturnValue(fakeDb())
    const refused = await POST(req('POST', { ...NEW, active: true }), ctx())
    expect(refused.status).toBe(422)
    expect((await refused.json()).code).toBe('not_configured')
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(req('POST', NEW), ctx())
    expect(res.status).toBe(201)
    const insert = db.calls.find((c) => c.op === 'insert')
    expect(insert.row).toMatchObject({ location_id: L1, slug: '20-5-pack', active: false, currency: 'EUR' })
  })
  it('a taken web address gets a number', async () => {
    const db = fakeDb({ studio: { id: L1, membership_source: 'glofox' }, slugs: ['20-5-pack', '20-5-pack-2'] })
    createServerClient.mockReturnValue(db)
    expect((await POST(req('POST', NEW), ctx())).status).toBe(201)
    expect(db.calls.find((c) => c.op === 'insert').row.slug).toBe('20-5-pack-3')
  })
})

describe('PATCH', () => {
  const current = { id: OFFER, location_id: L1, category: 'class_pack', price_cents: 1000, un1t_product_id: 'p1', active: true, starts_at: '2026-11-01T00:00:00Z', ends_at: null }
  it('a price change that breaks the un1t.online match is refused while active', async () => {
    createServerClient.mockReturnValue(fakeDb({ offers: [current], products: [{ un1t_id: 'p1', price_cents: 1000 }] }))
    const res = await PATCH(req('PATCH', { price_cents: 1200 }), ctx(L1, OFFER))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('price_mismatch')
  })
  it('switching an offer off is always allowed', async () => {
    const db = fakeDb({ offers: [current], products: [] })
    createServerClient.mockReturnValue(db)
    expect((await PATCH(req('PATCH', { active: false }), ctx(L1, OFFER))).status).toBe(200)
    expect(db.calls.find((c) => c.op === 'update').filters).toEqual([['id', OFFER], ['location_id', L1]])
  })
  it('an offer at another studio, or a bad id, is a 404', async () => {
    createServerClient.mockReturnValue(fakeDb({ offers: [{ ...current, location_id: L2 }] }))
    expect((await PATCH(req('PATCH', { name: 'X' }), ctx(L1, OFFER))).status).toBe(404)
    expect((await PATCH(req('PATCH', { name: 'X' }), ctx(L1, 'nope'))).status).toBe(404)
  })
})

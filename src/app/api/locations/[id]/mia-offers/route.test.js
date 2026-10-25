// MIAHATCH.4 (Task 14) — GET/PUT /api/locations/[id]/mia-offers: the products
// staff let Mia sell at a un1t.online studio. @/lib/auth is the REAL module
// (importActual) with only getCurrentUser mocked, so the real guards run.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const HATCH = 'a0000000-0000-0000-0000-0000000000a1'
const OTHER = 'b0000000-0000-0000-0000-0000000000b2'
const GLOFOX = 'c0000000-0000-0000-0000-0000000000c3'

const P1 = '11111111-1111-1111-1111-111111111111' // 1 Class Credit
const P2 = '22222222-2222-2222-2222-222222222222' // 5 Class Pack
const P3 = '33333333-3333-3333-3333-333333333333' // Founders (private)
const FREE = '44444444-4444-4444-4444-444444444444' // 0 euro
const OFF = '55555555-5555-5555-5555-555555555555' // inactive
const ELSEWHERE = '66666666-6666-6666-6666-666666666666' // another studio's

const user = (role, locs = [HATCH]) => ({
  id: 'u1', role, profileRole: role, isMaster: role === 'master',
  locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
  activeLocation: { id: locs[0] },
})
const OWNER = user('owner')
const MANAGER = user('manager')

// An in-memory db for exactly the chains the route uses; anything else throws
// so a drifted query fails loudly. Every write returns { error } like
// supabase-js, and `failOn` injects one.
function makeDb({ failOn = null } = {}) {
  const t = {
    locations: [
      { id: HATCH, membership_source: 'un1t_online' },
      { id: GLOFOX, membership_source: 'glofox' },
    ],
    un1t_products: [
      { id: P1, location_id: HATCH, title: '1 Class Credit', price_cents: 1500, status: 'active', visibility: 'public', billing_interval: null },
      { id: P2, location_id: HATCH, title: '5 Class Pack', price_cents: 6500, status: 'active', visibility: 'public', billing_interval: null },
      { id: P3, location_id: HATCH, title: 'Founders', price_cents: 9900, status: 'active', visibility: 'private', billing_interval: 'month' },
      { id: FREE, location_id: HATCH, title: 'Freebie', price_cents: 0, status: 'active', visibility: 'public', billing_interval: null },
      { id: OFF, location_id: HATCH, title: 'Old Pack', price_cents: 5000, status: 'inactive', visibility: 'public', billing_interval: null },
      { id: ELSEWHERE, location_id: OTHER, title: 'Elsewhere', price_cents: 1000, status: 'active', visibility: 'public', billing_interval: null },
    ],
    mia_purchase_offers: [],
  }
  const writes = []
  let seq = 0
  function from(table) {
    if (!t[table]) throw new Error(`unexpected table ${table}`)
    const filters = []
    let orderCols = []
    const match = (r) => filters.every((f) => f(r))
    const rows = () => {
      let out = t[table].filter(match)
      if (orderCols.length) out = [...out].sort((a, b) => {
        for (const c of orderCols) if (a[c] !== b[c]) return a[c] > b[c] ? 1 : -1
        return 0
      })
      return out
    }
    const chain = {
      select: () => chain,
      eq: (c, v) => { filters.push((r) => r[c] === v); return chain },
      in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return chain },
      gt: (c, v) => { filters.push((r) => r[c] > v); return chain },
      order: (c) => { orderCols.push(c); return chain },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve(
        failOn === `read:${table}` ? { data: null, error: { message: 'boom' } } : { data: rows(), error: null },
      ).then(res, rej),
      upsert(payload, opts) {
        writes.push({ op: 'upsert', table, payload, opts })
        if (failOn === `upsert:${table}`) return Promise.resolve({ error: { message: 'boom' } })
        const [a, b] = opts.onConflict.split(',')
        for (const p of payload) {
          const ex = t[table].find((r) => r[a] === p[a] && r[b] === p[b])
          if (ex) Object.assign(ex, p)
          else t[table].push({ id: `offer-${++seq}`, ...p })
        }
        return Promise.resolve({ error: null })
      },
      insert(payload) {
        writes.push({ op: 'insert', table, payload })
        if (failOn === `insert:${table}`) return Promise.resolve({ error: { message: 'boom' } })
        for (const p of payload) t[table].push({ id: `offer-${++seq}`, ...p })
        return Promise.resolve({ error: null })
      },
      delete() {
        const del = {
          eq: (c, v) => { filters.push((r) => r[c] === v); return del },
          in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return del },
          then: (res, rej) => {
            writes.push({ op: 'delete', table, ids: t[table].filter(match).map((r) => r.id) })
            if (failOn === `delete:${table}`) return Promise.resolve({ error: { message: 'boom' } }).then(res, rej)
            t[table] = t[table].filter((r) => !match(r))
            return Promise.resolve({ error: null }).then(res, rej)
          },
        }
        return del
      },
    }
    return chain
  }
  return { from, t, writes }
}

const props = (id) => ({ params: { id } })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/mia-offers`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/mia-offers`)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER)
})

describe('GET /api/locations/[id]/mia-offers', () => {
  it('GET 404 for a foreign location', async () => {
    getCurrentUser.mockResolvedValue(user('owner', [OTHER]))
    const res = await GET(get(HATCH), props(HATCH))
    expect(res.status).toBe(404)
  })

  it('401 with no user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(HATCH), props(HATCH))).status).toBe(401)
  })

  it('400 at a studio that is not on un1t.online', async () => {
    getCurrentUser.mockResolvedValue(user('owner', [GLOFOX]))
    const res = await GET(get(GLOFOX), props(GLOFOX))
    expect(res.status).toBe(400)
  })

  it('lists the sellable products (active, above zero, this studio only) and the saved offers in order', async () => {
    db.t.mia_purchase_offers.push(
      { id: 'o2', location_id: HATCH, un1t_product_row_id: P3, sort_order: 1, blurb: 'Best value' },
      { id: 'o1', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: '' },
    )
    const res = await GET(get(HATCH), props(HATCH))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.products.map((p) => p.id).sort()).toEqual([P1, P2, P3].sort())
    expect(data.products.find((p) => p.id === P3)).toEqual({ id: P3, title: 'Founders', price_cents: 9900, interval: 'month', private: true })
    expect(data.offers.map((o) => o.un1t_product_row_id)).toEqual([P1, P3])
    expect(data.offers[1]).toEqual({
      id: 'o2', un1t_product_row_id: P3, title: 'Founders', price_cents: 9900, interval: 'month',
      visibility: 'private', private: true, blurb: 'Best value', sort_order: 1, inactive: false,
    })
  })

  it('offers that share a sort_order come back by id, so the order is stable mid-save', async () => {
    db.t.mia_purchase_offers.push(
      { id: 'o-b', location_id: HATCH, un1t_product_row_id: P2, sort_order: 0, blurb: '' },
      { id: 'o-a', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: '' },
    )
    const { data } = await (await GET(get(HATCH), props(HATCH))).json()
    expect(data.offers.map((o) => o.id)).toEqual(['o-a', 'o-b'])
  })

  it('GET marks an offer inactive after the product goes inactive', async () => {
    db.t.mia_purchase_offers.push({ id: 'o1', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: null })
    db.t.un1t_products.find((p) => p.id === P1).status = 'inactive'
    const { data } = await (await GET(get(HATCH), props(HATCH))).json()
    expect(data.offers[0].inactive).toBe(true)
    expect(data.products.map((p) => p.id)).not.toContain(P1)
  })

  it('500 when a read fails, never an empty list', async () => {
    db = makeDb({ failOn: 'read:mia_purchase_offers' })
    createServerClient.mockReturnValue(db)
    expect((await GET(get(HATCH), props(HATCH))).status).toBe(500)
  })
})

describe('PUT /api/locations/[id]/mia-offers', () => {
  it('PUT 403 for a manager who is not owner (canEditMiaSettings)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER)
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P1, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })

  it('PUT 404 for a foreign location, nothing written', async () => {
    getCurrentUser.mockResolvedValue(user('owner', [OTHER]))
    const res = await PUT(put(HATCH, { offers: [] }), props(HATCH))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('400 at a studio that is not on un1t.online', async () => {
    getCurrentUser.mockResolvedValue(user('owner', [GLOFOX]))
    const res = await PUT(put(GLOFOX, { offers: [] }), props(GLOFOX))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })

  it('PUT saves order and blurbs', async () => {
    const res = await PUT(put(HATCH, { offers: [
      { un1t_product_row_id: P2, blurb: '  Five classes, one price  ' },
      { un1t_product_row_id: P1, blurb: '' },
    ] }), props(HATCH))
    expect(res.status).toBe(200)
    const rows = db.t.mia_purchase_offers
    expect(rows.map((r) => [r.un1t_product_row_id, r.sort_order, r.blurb])).toEqual([
      [P2, 0, 'Five classes, one price'],
      [P1, 1, null],
    ])
    expect(rows.every((r) => r.created_by === 'u1' && r.location_id === HATCH)).toBe(true)
    const { data } = await res.json()
    expect(data.offers.map((o) => o.un1t_product_row_id)).toEqual([P2, P1])
  })

  it('a second save reorders and drops rows not in the new list, keeping the survivors', async () => {
    await PUT(put(HATCH, { offers: [
      { un1t_product_row_id: P1, blurb: 'a' }, { un1t_product_row_id: P2, blurb: 'b' }, { un1t_product_row_id: P3, blurb: 'c' },
    ] }), props(HATCH))
    const keptId = db.t.mia_purchase_offers.find((r) => r.un1t_product_row_id === P3).id
    getCurrentUser.mockResolvedValue({ ...OWNER, id: 'u9' })
    const res = await PUT(put(HATCH, { offers: [
      { un1t_product_row_id: P3, blurb: 'c2' }, { un1t_product_row_id: P1, blurb: 'a' },
    ] }), props(HATCH))
    expect(res.status).toBe(200)
    const rows = db.t.mia_purchase_offers
    expect(rows.map((r) => [r.un1t_product_row_id, r.sort_order, r.blurb]).sort()).toEqual([
      [P1, 1, 'a'], [P3, 0, 'c2'],
    ])
    const p3 = rows.find((r) => r.un1t_product_row_id === P3)
    expect(p3.id).toBe(keptId)
    expect(p3.created_by).toBe('u1') // the original author is not overwritten
    expect(p3.updated_at).toBeTruthy()
  })

  it('an empty list clears the studio', async () => {
    db.t.mia_purchase_offers.push({ id: 'o1', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: null })
    const res = await PUT(put(HATCH, { offers: [] }), props(HATCH))
    expect(res.status).toBe(200)
    expect(db.t.mia_purchase_offers).toEqual([])
  })

  it('€0 product refused', async () => {
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: FREE, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'product_not_sellable', product_id: FREE })
    expect(db.writes).toEqual([])
  })

  it('inactive product refused', async () => {
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P1, blurb: '' }, { un1t_product_row_id: OFF, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'product_not_sellable', product_id: OFF })
    expect(db.writes).toEqual([])
  })

  it('product of another studio refused', async () => {
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: ELSEWHERE, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'product_not_sellable', product_id: ELSEWHERE })
    expect(db.writes).toEqual([])
  })

  it('an unknown product id is refused the same way', async () => {
    const ghost = '77777777-7777-7777-7777-777777777777'
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: ghost, blurb: '' }] }), props(HATCH))
    expect(await res.json()).toMatchObject({ error: 'product_not_sellable', product_id: ghost })
  })

  it('private product allowed and flagged', async () => {
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P3, blurb: 'Members only' }] }), props(HATCH))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.offers[0]).toMatchObject({ un1t_product_row_id: P3, visibility: 'private', private: true })
  })

  it('refuses a blurb over 140 characters and a repeated product', async () => {
    expect((await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P1, blurb: 'x'.repeat(141) }] }), props(HATCH))).status).toBe(400)
    expect((await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P1, blurb: '' }, { un1t_product_row_id: P1, blurb: '' }] }), props(HATCH))).status).toBe(400)
    expect(db.writes).toEqual([])
  })

  it('a failed write is a 500, and a failed save never deletes the existing rows first', async () => {
    db = makeDb({ failOn: 'insert:mia_purchase_offers' })
    createServerClient.mockReturnValue(db)
    db.t.mia_purchase_offers.push({ id: 'o1', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: null })
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P2, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(500)
    expect(db.t.mia_purchase_offers.map((r) => r.id)).toEqual(['o1'])
    expect(db.writes.some((w) => w.op === 'delete')).toBe(false)
  })

  it('a failed delete of the stale rows is a 500', async () => {
    db = makeDb({ failOn: 'delete:mia_purchase_offers' })
    createServerClient.mockReturnValue(db)
    db.t.mia_purchase_offers.push({ id: 'o1', location_id: HATCH, un1t_product_row_id: P1, sort_order: 0, blurb: null })
    const res = await PUT(put(HATCH, { offers: [{ un1t_product_row_id: P2, blurb: '' }] }), props(HATCH))
    expect(res.status).toBe(500)
  })
})

// WAYSIN.4 — /api/locations/[id]/corp-promos and /[promoId]: manager+ reads,
// owner/master AT the studio writes, another studio is a 404, the key is
// immutable, a promo with claims cannot be deleted, a Glofox promo needs its
// plan binding.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/landing-pages', () => ({ studioPublicPath: vi.fn(async () => 'stillorgan') }))

import { GET, POST } from './route'
import { PATCH, DELETE } from './[promoId]/route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())

const owner = {
  id: 'u1', role: 'owner', profileRole: 'owner', isMaster: false,
  activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }], rolesByLocation: { loc1: 'owner' },
}
const withRole = (role) => ({ ...owner, role, profileRole: role, rolesByLocation: { loc1: role } })
const stranger = { ...owner, locations: [{ id: 'other' }], rolesByLocation: { other: 'owner' }, activeLocation: { id: 'other' } }

const ROW = {
  id: 'p1', location_id: 'loc1', key: 'stillorgan-newstart', name: 'New Start', platform: 'glofox',
  credits: 3, expires_in_days: 7, live: true, tag: 'stillorgan-newstart', lead_source: 'corp_promo',
  glofox_membership_id: 'm1', glofox_plan_code: 'pc1', glofox_plan_name: 'New Start',
}

// A small chainable fake: every builder records its calls and resolves per table.
function mockDb({ source = 'glofox', rows = [ROW], promo = ROW, claims = 0, insertError = null } = {}) {
  const writes = { insert: [], update: [], delete: 0 }
  createServerClient.mockReturnValue({
    from: (table) => {
      const q = { _table: table, _op: 'select' }
      const chain = new Proxy(q, {
        get(target, prop) {
          if (prop === 'then') {
            const result = resolve(target)
            return (res, rej) => Promise.resolve(result).then(res, rej)
          }
          if (prop === 'insert') return (r) => { writes.insert.push(r); target._op = 'insert'; target._row = r; return chain }
          if (prop === 'update') return (r) => { writes.update.push(r); target._op = 'update'; target._row = r; return chain }
          if (prop === 'delete') return () => { writes.delete += 1; target._op = 'delete'; return chain }
          if (prop === 'select') return (_c, opts) => { if (opts?.head) target._head = true; return chain }
          if (prop === 'eq') return (col, val) => { (target._eq ||= []).push([col, val]); return chain }
          if (prop === 'maybeSingle' || prop === 'single') return () => { target._one = true; return chain }
          if (prop in target) return target[prop]
          return () => chain
        },
      })
      return chain
    },
  })
  function resolve(t) {
    if (t._table === 'locations') return { data: source === null ? null : { id: 'loc1', membership_source: source }, error: null }
    if (t._table === 'corp_promo_claims') return { count: claims, data: null, error: null }
    if (t._table === 'corp_promos') {
      if (t._op === 'insert') return insertError ? { data: null, error: insertError } : { data: { id: 'new', ...t._row }, error: null }
      if (t._op === 'update') return { data: promo ? { ...promo, ...t._row } : null, error: null }
      if (t._op === 'delete') return { data: promo ? [{ id: promo.id }] : [], error: null }
      if (t._one) return { data: promo, error: null }
      // Honours the reader's filters, so a dropped `.eq('live', true)` shows.
      const eqs = t._eq || []
      return { data: rows.filter((r) => eqs.every(([c, v]) => r[c] === v)), error: null }
    }
    return { data: null, error: null }
  }
  return writes
}

const listProps = { params: Promise.resolve({ id: 'loc1' }) }
const itemProps = { params: Promise.resolve({ id: 'loc1', promoId: 'p1' }) }
const json = (method, body, url = 'http://x/api/locations/loc1/corp-promos') => new Request(url, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
})
const CREATE = {
  key: 'acme-3-free', name: 'Acme corporate', credits: 3, expires_in_days: 7, tag: 'acme_corp', lead_source: '  Acme_Corp ',
  glofox_membership_id: 'm9', glofox_plan_code: 'pc9', glofox_plan_name: 'Acme plan',
}

const OFF_ROW = { ...ROW, id: 'p2', key: 'acme-3-free', name: 'Acme', live: false }
// A plain staff member whose studio switched the landing page editor on for them.
const landingEditor = {
  ...withRole('staff'),
  assignmentsByLocation: { loc1: { role: 'staff', permissions: { landing_page: true } } },
}
const LIVE_URL = 'http://x/api/locations/loc1/corp-promos?live=1'

describe('GET ?live=1 (the landing editor picker)', () => {
  it('reaches listCorpPromos with liveOnly: only the live rows come back', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    mockDb({ rows: [ROW, OFF_ROW] })
    const { data } = await (await GET(new Request(LIVE_URL), listProps)).json()
    expect(data.promos.map((p) => p.key)).toEqual(['stillorgan-newstart'])
    // Without ?live=1 the same fake returns both, so the filter came from the route.
    const all = await (await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)).json()
    expect(all.data.promos.map((p) => p.key)).toEqual(['stillorgan-newstart', 'acme-3-free'])
  })
  it('returns the trimmed row: no Glofox ids, no platform, no can_edit', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    const { data } = await (await GET(new Request(LIVE_URL), listProps)).json()
    expect(data.promos).toEqual([{ id: 'p1', key: 'stillorgan-newstart', name: 'New Start', credits: 3, expiresInDays: 7, live: true }])
    expect(data).not.toHaveProperty('can_edit')
    expect(data).not.toHaveProperty('platform')
    expect(JSON.stringify(data)).not.toMatch(/glofox|pc1|m1"/)
  })
  it('admits a staff member holding landing_page at the studio', async () => {
    getCurrentUser.mockResolvedValue(landingEditor)
    mockDb()
    const res = await GET(new Request(LIVE_URL), listProps)
    expect(res.status).toBe(200)
    expect((await res.json()).data.promos[0].key).toBe('stillorgan-newstart')
  })
  it('but not to the full list', async () => {
    getCurrentUser.mockResolvedValue(landingEditor)
    mockDb()
    expect((await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)).status).toBe(403)
  })
  it('refuses plain staff without landing_page', async () => {
    getCurrentUser.mockResolvedValue(withRole('staff'))
    mockDb()
    expect((await GET(new Request(LIVE_URL), listProps)).status).toBe(403)
  })
  it('another studio is still a 404', async () => {
    getCurrentUser.mockResolvedValue(stranger)
    mockDb()
    expect((await GET(new Request(LIVE_URL), listProps)).status).toBe(404)
  })
})

describe('GET', () => {
  it('another studio is a 404', async () => {
    getCurrentUser.mockResolvedValue(stranger)
    mockDb()
    expect((await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)).status).toBe(404)
  })
  it('a manager reads the list; can_edit false', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    mockDb()
    const res = await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.can_edit).toBe(false)
    expect(data.platform).toBe('glofox')
    expect(data.public_path).toBe('stillorgan')
    expect(data.promos.map((p) => p.key)).toEqual(['stillorgan-newstart'])
  })
  it('plain staff are refused', async () => {
    getCurrentUser.mockResolvedValue(withRole('staff'))
    mockDb()
    expect((await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)).status).toBe(403)
  })
  it('an owner may edit', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    expect((await (await GET(new Request('http://x/api/locations/loc1/corp-promos'), listProps)).json()).data.can_edit).toBe(true)
  })
})

describe('POST', () => {
  it('a manager is refused', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    const writes = mockDb()
    expect((await POST(json('POST', CREATE), listProps)).status).toBe(403)
    expect(writes.insert).toEqual([])
  })
  it('a bad key is a 400', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    expect((await POST(json('POST', { ...CREATE, key: '-Bad Key' }), listProps)).status).toBe(400)
    expect(writes.insert).toEqual([])
  })
  it('an owner creates: 201, platform from the studio, lead source lowercased and trimmed', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    const res = await POST(json('POST', CREATE), listProps)
    expect(res.status).toBe(201)
    expect(writes.insert[0]).toMatchObject({ location_id: 'loc1', key: 'acme-3-free', platform: 'glofox', lead_source: 'acme_corp', live: false, created_by: 'u1' })
    expect((await res.json()).data.promo.key).toBe('acme-3-free')
  })
  it('a Glofox studio without a plan binding is glofox_plan_missing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    const res = await POST(json('POST', { ...CREATE, glofox_plan_code: '' }), listProps)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('glofox_plan_missing')
    expect(writes.insert).toEqual([])
  })
  it('a un1t.online studio stores no Glofox fields', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb({ source: 'un1t_online' })
    const { glofox_membership_id: _a, glofox_plan_code: _b, glofox_plan_name: _c, ...un1t } = CREATE
    expect((await POST(json('POST', un1t), listProps)).status).toBe(201)
    expect(writes.insert[0]).toMatchObject({ platform: 'un1t_online', glofox_membership_id: null, glofox_plan_code: null, glofox_plan_name: null })
  })
  it('a duplicate key is a 409', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({ insertError: { code: '23505', message: 'dup' } })
    const res = await POST(json('POST', CREATE), listProps)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('key_taken')
  })
})

describe('PATCH', () => {
  const url = 'http://x/api/locations/loc1/corp-promos/p1'
  it('cannot change the key', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    const res = await PATCH(json('PATCH', { key: 'renamed', name: 'x' }, url), itemProps)
    expect(res.status).toBe(400)
    expect(writes.update).toEqual([])
  })
  it('switches a promo off', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    const res = await PATCH(json('PATCH', { live: false }, url), itemProps)
    expect(res.status).toBe(200)
    expect(writes.update[0]).toMatchObject({ live: false })
    expect(writes.update[0].key).toBeUndefined()
  })
  it('clearing a Glofox promo\'s plan is glofox_plan_missing', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb()
    const res = await PATCH(json('PATCH', { glofox_plan_code: null }, url), itemProps)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('glofox_plan_missing')
    expect(writes.update).toEqual([])
  })
  it('another studio\'s promo is a 404', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({ promo: null })
    expect((await PATCH(json('PATCH', { live: false }, url), itemProps)).status).toBe(404)
  })
  it('a manager is refused', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    const writes = mockDb()
    expect((await PATCH(json('PATCH', { live: false }, url), itemProps)).status).toBe(403)
    expect(writes.update).toEqual([])
  })
})

describe('DELETE', () => {
  const req = () => new Request('http://x/api/locations/loc1/corp-promos/p1', { method: 'DELETE' })
  const OFF = { ...ROW, live: false }
  it('a live promo is 409 still_live and nothing is deleted', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb({ claims: 0 })
    const res = await DELETE(req(), itemProps)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('still_live')
    expect(body.error).toBe('Switch this promo off first.')
    expect(writes.delete).toBe(0)
  })
  it('a promo with claims is 409 has_claims and nothing is deleted', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb({ promo: OFF, claims: 2 })
    const res = await DELETE(req(), itemProps)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('has_claims')
    expect(writes.delete).toBe(0)
  })
  it('a switched-off promo without claims is deleted', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb({ promo: OFF, claims: 0 })
    expect((await DELETE(req(), itemProps)).status).toBe(200)
    expect(writes.delete).toBe(1)
  })
  it('a failed claims count refuses the delete', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const writes = mockDb({ promo: OFF, claims: null })
    expect((await DELETE(req(), itemProps)).status).toBe(500)
    expect(writes.delete).toBe(0)
  })
})

// UN1TWRITE.18 — the landing editor refuses a paid class_funnel at a
// un1t.online studio: anything paid there goes through un1t.online checkout.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let locRead
const upserts = []
const db = {
  from(table) {
    const b = {
      select: () => b, eq: () => b,
      upsert: (row) => { upserts.push(row); return b },
      maybeSingle: async () => (table === 'locations' ? locRead : { data: null, error: null }),
      single: async () => ({ data: { ok: true }, error: null }),
    }
    return b
  },
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'U1' })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/permissions', async (importOriginal) => ({ ...(await importOriginal()), hasPermissionForLocation: vi.fn(() => true) }))

import { PUT } from './route.js'

const LOC = '11111111-1111-4111-8111-111111111111'
const put = (blocks) => PUT(new Request('http://localhost/api/landing-page-settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ location_id: LOC, blocks }),
}))
const funnel = (price) => [{ id: 'b1', type: 'class_funnel', price_cents: price }]

beforeEach(() => { vi.clearAllMocks(); upserts.length = 0; locRead = { data: { membership_source: 'un1t_online' }, error: null } })

describe('UN1TWRITE.18 — no paid intro at a un1t.online studio', () => {
  it('refuses a price at a un1t.online studio and saves nothing', async () => {
    const res = await put(funnel(1500))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Paid intros are not available at a un1t.online studio: anything paid goes through un1t.online checkout.')
    expect(upserts).toHaveLength(0)
  })

  it('accepts a price at a Glofox studio, and a free funnel at a un1t.online studio', async () => {
    locRead = { data: { membership_source: 'glofox' }, error: null }
    expect((await put(funnel(1500))).status).toBe(200)
    locRead = { data: { membership_source: 'un1t_online' }, error: null }
    expect((await put(funnel(0))).status).toBe(200)
    expect(upserts).toHaveLength(2)
  })

  it('an unreadable location row with a priced funnel is a 503, never a save', async () => {
    locRead = { data: null, error: { code: 'XX' } }
    expect((await put(funnel(1500))).status).toBe(503)
    expect(upserts).toHaveLength(0)
  })
})

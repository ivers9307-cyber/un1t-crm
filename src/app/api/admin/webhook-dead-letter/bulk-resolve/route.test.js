// MAIL-DEADLETTER.1 review fix — bulk-resolve is bounded to the caller's
// owner locations.
//
// The route gated on the caller's ACTIVE role and then UPDATEd every open row
// of the named provider with no location bound, so an owner in org A could
// acknowledge org B's unfiled mail in one POST. Now: master is unbounded;
// anyone else gets `.in('location_id', <locations where they are OWNER>)` on
// the write — which, like SQL's IN, never matches a NULL-location row.
//
// @/lib/auth is the REAL module with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const MASTER = { id: 'u-master', role: 'owner', profileRole: 'master', isMaster: true, rolesByLocation: {} }
const OWNER_A = { id: 'u-owner-a', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: { [LOC_A]: 'owner' } }
const MANAGER_A = { id: 'u-mgr-a', role: 'manager', profileRole: 'manager', isMaster: false, rolesByLocation: { [LOC_A]: 'manager' } }
const PHANTOM_OWNER = { id: 'u-phantom', role: 'owner', profileRole: 'owner', isMaster: false, rolesByLocation: {} }

const ROWS = [
  { id: 1, provider: 'zoom_contact_sync', status: 'pending', location_id: LOC_A },
  { id: 2, provider: 'zoom_contact_sync', status: 'failed', location_id: LOC_B },
  { id: 3, provider: 'zoom_contact_sync', status: 'pending', location_id: null },
  { id: 4, provider: 'zoom_contact_sync', status: 'resolved', location_id: LOC_A },
  { id: 5, provider: 'postmark_inbound', status: 'pending', location_id: LOC_A },
]

// ── fake db ─────────────────────────────────────────────────────────────────
// update(patch).eq/.in(...).select() — filters applied like SQL (IN never
// matches NULL); the touched ids come back from select().
let filters
let writes

function makeDb() {
  return {
    from: () => {
      let rows = [...ROWS]
      const b = {}
      b.update = (patch) => { writes.push(patch); return b }
      b.eq = (col, val) => { filters.push(['eq', col, val]); rows = rows.filter(r => r[col] === val); return b }
      b.in = (col, vals) => {
        filters.push(['in', col, vals])
        rows = rows.filter(r => r[col] !== null && r[col] !== undefined && vals.includes(r[col]))
        return b
      }
      b.select = () => Promise.resolve({ data: rows.map(r => ({ id: r.id })), error: null })
      return b
    },
  }
}

function call(body) {
  return POST({ json: async () => body })
}

const locationFilters = () => filters.filter(([, col]) => col === 'location_id')

beforeEach(() => {
  vi.clearAllMocks()
  filters = []
  writes = []
  createServerClient.mockImplementation(() => makeDb())
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('POST /api/admin/webhook-dead-letter/bulk-resolve — the write is bounded', () => {
  it('master acknowledges every open row of the provider, NULL-location ones included, with no location bound', async () => {
    const res = await call({ provider: 'zoom_contact_sync' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data).toEqual({ provider: 'zoom_contact_sync', status: 'resolved', updated: 3 })
    expect(locationFilters()).toHaveLength(0)
    expect(writes[0].status).toBe('resolved')
    expect(typeof writes[0].resolved_at).toBe('string')
  })

  it('an owner touches ONLY rows at the locations they own — another org\'s rows and NULL rows are left alone', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A)
    const res = await call({ provider: 'zoom_contact_sync' })
    const json = await res.json()
    expect(res.status).toBe(200)
    // Row 1 only: 2 is org B, 3 has no location, 4 is already resolved.
    expect(json.data.updated).toBe(1)
    expect(locationFilters()).toEqual([['in', 'location_id', [LOC_A]]])
  })

  it('an active-role "owner" who owns no location touches nothing and issues no write', async () => {
    getCurrentUser.mockResolvedValue(PHANTOM_OWNER)
    const res = await call({ provider: 'zoom_contact_sync' })
    expect(res.status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('a manager is refused (403 — collection route) and nothing is written', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await call({ provider: 'zoom_contact_sync' })).status).toBe(403)
    expect(writes).toHaveLength(0)
  })

  it('anonymous is 401', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await call({ provider: 'zoom_contact_sync' })).status).toBe(401)
  })
})

describe('POST /api/admin/webhook-dead-letter/bulk-resolve — body contract (unchanged)', () => {
  it('requires a provider — there is no "all providers" mode', async () => {
    expect((await call({})).status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('discard also stamps resolved_at', async () => {
    const json = await (await call({ provider: 'zoom_contact_sync', status: 'discarded' })).json()
    expect(json.data.status).toBe('discarded')
    expect(writes[0].status).toBe('discarded')
    expect(typeof writes[0].resolved_at).toBe('string')
  })

  it('rejects any other target status', async () => {
    expect((await call({ provider: 'zoom_contact_sync', status: 'pending' })).status).toBe(400)
  })

  it('only open rows (pending/failed) are touched', async () => {
    await call({ provider: 'zoom_contact_sync' })
    expect(filters).toEqual(expect.arrayContaining([['in', 'status', ['pending', 'failed']]]))
  })
})

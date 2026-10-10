// W1.M2 — PUT /api/locations/[id]/membership-source is THE ONLY writer of
// locations.membership_source (mig 717 grants the browser SELECT, no UPDATE).
//
// What is pinned here:
//   - owner AT THE TARGET or master → 200, `locations.update({ membership_source })`
//     keyed by id, and the response is membershipSourceState() for the row
//   - 'un1t' (admitted by the mig 717 CHECK, no provider registered yet) →
//     400 code 'not_available_yet', nothing written. The route judges the
//     REGISTRY (MEMBERSHIP_SOURCES), not the CHECK, so nobody can select the
//     home-grown source before its module lands (Richard's decision)
//   - a value outside the CHECK → 400 (Zod), nothing written
//   - manager at the target → 403; a location the caller is not at → 404
//     (assertLocationAccessOr404 — a detail route never confirms an id)
//   - switching to 'none' while an ACTIVE glofox registry row exists → 200
//     with warning 'glofox_credentials_kept': the switch never deletes a
//     credential (Disconnect in the hub does that)
//   - every switch writes an audit_events row (fire-and-forget)
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so the real guards' contracts are what run here (Style B).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/membership/source', async () => {
  const actual = await vi.importActual('@/lib/membership/source')
  return { ...actual, membershipSourceState: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => ({ logged: true })) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { membershipSourceState } from '@/lib/membership/source'
import { logAuditEvent } from '@/lib/audit'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER_A = {
  id: 'u1', email: 'owner@example.test', full_name: 'Owner A',
  role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MANAGER_A = {
  id: 'u4', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// Owner at A, plain staff at B: `user.role` reads 'owner' (resolved at the
// ACTIVE studio) and must not carry them onto B.
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// The route's three chains, modelled honestly and failing LOUD elsewhere:
//   locations  .select('id, name, membership_source').eq('id', id).maybeSingle()
//   locations  .update({...}).eq('id', id)
//   channel_connections .select('id', head count).eq('location_id', id).eq('platform','glofox').eq('is_active', true)
function makeDb({ rows = {}, activeGlofoxRows = 0 } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table === 'locations') {
        return {
          select(cols) {
            return {
              eq: (col, val) => {
                if (col !== 'id') throw new Error(`unexpected locations .eq('${col}')`)
                return {
                  maybeSingle: async () => ({ data: rows[val] ? { id: val, name: rows[val].name, membership_source: rows[val].membership_source, _cols: cols } : null, error: null }),
                }
              },
            }
          },
          update(payload) {
            return {
              eq: async (col, val) => {
                if (col !== 'id') throw new Error(`unexpected locations update .eq('${col}')`)
                updates.push({ payload, id: val })
                if (rows[val]) Object.assign(rows[val], payload)
                return { data: null, error: null }
              },
            }
          },
        }
      }
      if (table === 'channel_connections') {
        const filters = {}
        const b = {
          select: () => b,
          eq: (col, val) => { filters[col] = val; return b },
          then: (res, rej) => {
            const ok = filters.location_id && filters.platform === 'glofox' && filters.is_active === true
            return Promise.resolve({ count: ok ? activeGlofoxRows : 0, error: null }).then(res, rej)
          },
        }
        return b
      }
      throw new Error(`unexpected db.from('${table}') in membership-source test`)
    },
  }
}

const props = (id) => ({ params: { id } })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/membership-source`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb({ rows: { [LOC_A]: { name: 'Studio A', membership_source: 'none' }, [LOC_B]: { name: 'Studio B', membership_source: 'glofox' } } })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
  membershipSourceState.mockImplementation(async (_db, id) => {
    const src = db.from && (await db.from('locations').select('membership_source').eq('id', id).maybeSingle()).data?.membership_source
    if (src === 'glofox') return { source: 'glofox', state: 'unconfigured', missing: ['API Key'] }
    return { source: 'none', state: 'none' }
  })
})

describe('PUT /api/locations/[id]/membership-source — the legitimate switch', () => {
  it('an owner at the location selects glofox: 200, one update by id, the body is the resolved state', async () => {
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.updates).toEqual([{ id: LOC_A, payload: { membership_source: 'glofox', updated_at: expect.any(String) } }])
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      data: { source: 'glofox', state: 'unconfigured', missing: ['API Key'], previous: 'none' },
    })
    expect(membershipSourceState).toHaveBeenCalledWith(db, LOC_A)
  })

  it('a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.updates).toHaveLength(1)
  })

  it('writes an audit_events row naming actor, location, from and to (fire-and-forget)', async () => {
    await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(logAuditEvent).toHaveBeenCalledTimes(1)
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      category: 'business',
      action: 'location.membership_source_changed',
      actor: { id: 'u1' },
      target: { resource: `location/${LOC_A}`, label: 'Studio A' },
      locationId: LOC_A,
      details: { from: 'none', to: 'glofox', via: 'membership-source' },
    })
  })

  it('a failed audit write never fails the switch', async () => {
    logAuditEvent.mockRejectedValueOnce(new Error('audit down'))
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.updates).toHaveLength(1)
  })

  it('selecting the value already set is a no-op 200 with no write and no audit row', async () => {
    const res = await PUT(put(LOC_A, { membership_source: 'none' }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.updates).toEqual([])
    expect(logAuditEvent).not.toHaveBeenCalled()
    expect((await res.json()).data).toMatchObject({ source: 'none', state: 'none', previous: 'none' })
  })

  it("'none' while an ACTIVE glofox registry row exists → 200 with warning glofox_credentials_kept, nothing deleted", async () => {
    db = makeDb({ rows: { [LOC_B]: { name: 'Studio B', membership_source: 'glofox' } }, activeGlofoxRows: 1 })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_B, { membership_source: 'none' }), props(LOC_B))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBe('glofox_credentials_kept')
    expect(body.data).toMatchObject({ source: 'none', state: 'none', previous: 'glofox' })
    // Exactly ONE write, and it touches membership_source only — never settings, never channel_connections.
    expect(db.updates).toEqual([{ id: LOC_B, payload: { membership_source: 'none', updated_at: expect.any(String) } }])
  })

  it("'none' with no active glofox row carries no warning", async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_B, { membership_source: 'none' }), props(LOC_B))
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toBeUndefined()
  })
})

describe('PUT /api/locations/[id]/membership-source — refusals write nothing', () => {
  it("'un1t' is a known key with no registered provider → 400 not_available_yet", async () => {
    const res = await PUT(put(LOC_A, { membership_source: 'un1t' }), props(LOC_A))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('not_available_yet')
    expect(body.error).toMatch(/not available yet/i)
    expect(db.updates).toEqual([])
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('a value the CHECK does not admit → 400 from validation', async () => {
    const res = await PUT(put(LOC_A, { membership_source: 'mindbody' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.updates).toEqual([])
  })

  it('a manager at the target → 403', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(403)
    expect(db.updates).toEqual([])
  })

  it('an owner-at-A who is staff at the target B → 403 (the role is judged AT THE TARGET)', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { membership_source: 'none' }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.updates).toEqual([])
  })

  it('a location the caller is not at → 404, never a role complaint that confirms the id', async () => {
    const res = await PUT(put(LOC_B, { membership_source: 'none' }), props(LOC_B))
    expect(res.status).toBe(404)
    expect(db.updates).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put(LOC_A, { nonsense: true }), props(LOC_A))
    expect(res.status).toBe(403)
  })

  it('401 anonymous', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.updates).toEqual([])
  })

  it('a row that no longer exists → 404 after the gates', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    db = makeDb({ rows: {} })
    createServerClient.mockReturnValue(db)
    const res = await PUT(put(LOC_A, { membership_source: 'glofox' }), props(LOC_A))
    expect(res.status).toBe(404)
    expect(db.updates).toEqual([])
  })
})

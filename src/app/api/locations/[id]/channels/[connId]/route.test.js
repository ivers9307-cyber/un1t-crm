// LOCFIX-ROLEGATE.1 — PATCH and DELETE
// /api/locations/[id]/channels/[connId] edit or remove a channel connection
// (Instagram / Messenger creds) on the PATH-PARAM location.
//
// THE GATE IS THE POINT. Both handlers used ONE boolean —
//   user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)
// — and `user.role` resolves at the caller's ACTIVE location (with auth.js's
// highest-role-anywhere fallback). So a manager at studio A who is plain
// STAFF at studio B could PATCH B's connection (flip `agent_enabled`, point
// `external_account_id` at their own IG account) or DELETE it outright,
// silencing B's DMs, with a 200. The boolean is now split into the two
// questions it was conflating: membership (assertLocationAccess) then the
// role AT THE TARGET (hasRoleAtLocation + MANAGER_ROLES).
//
// The membership half therefore now answers assertLocationAccess's own copy
// ("Forbidden — location not in your assignments") instead of the generic
// "Forbidden" — an intended, more informative change, pinned below.
//
// TIER A: MANAGER_ROLES INCLUDES head_coach — pinned, and deliberately
// different from the stripe-connect routes' ['master','owner','manager'].
//
// Every refusal asserts NO WRITE HAPPENED, not merely the status code.
// @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { PATCH, DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const CONN = 'c0000000-0000-0000-0000-0000000000c1'

const MANAGER_A = {
  id: 'u1', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — manager at the ACTIVE studio, plain staff at the target.
const MANAGER_A_STAFF_B = {
  id: 'u2', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — the target's real manager, active studio elsewhere.
const STAFF_A_MANAGER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'manager' },
  activeLocation: { id: LOC_A },
}
const STAFF_A_HEAD_COACH_B = {
  id: 'u4', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// The route's shapes against channel_connections, modelled honestly:
//   PATCH .select('platform').eq('id').eq('location_id').maybeSingle()
//         .update({is_active:false}).eq×3.neq     (bare await — the sweep)
//         .update(patch).eq('id').eq('location_id').select().single()
//   DELETE .delete().eq('id').eq('location_id')
// Every mutating call is logged AT THE CALL, so a refusal that reached the DB
// at all shows up as a non-empty log. Fail LOUD on any other table.
function makeDb({ existing = { platform: 'instagram' } } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'channel_connections') throw new Error(`unexpected db.from('${table}') in channel-detail test`)
      return {
        select(cols) {
          if (cols !== 'platform') throw new Error(`unexpected .select('${cols}') in channel-detail test`)
          const filters = {}
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            maybeSingle: () => Promise.resolve({
              data: existing && filters.location_id ? { ...existing } : null,
              error: null,
            }),
          }
          return builder
        },
        update(patch) {
          const filters = {}
          writes.push({ op: 'update', patch, filters })
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            neq(col, val) { filters[`not_${col}`] = val; return builder },
            select: () => ({
              single: () => Promise.resolve({
                data: { id: filters.id, location_id: filters.location_id, platform: existing?.platform, ...patch },
                error: null,
              }),
            }),
            then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
          }
          return builder
        },
        delete() {
          const filters = {}
          writes.push({ op: 'delete', filters })
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          }
          return builder
        },
      }
    },
  }
}

const props = (id, connId) => ({ params: { id, connId } })
const patchReq = (id, connId, body) => new Request(`http://localhost/api/locations/${id}/channels/${connId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const delReq = (id, connId) => new Request(`http://localhost/api/locations/${id}/channels/${connId}`, { method: 'DELETE' })

const VALID = { label: 'Renamed studio IG', is_active: true }

// The exact body the channels card parses today — the masked shape, pinned as
// a literal rather than rebuilt from maskConnectionRow.
const successBody = (locationId, updatedBy) => ({
  success: true,
  connection: {
    id: CONN,
    location_id: locationId,
    platform: 'instagram',
    label: 'Renamed studio IG',
    is_active: true,
    updated_at: expect.any(String),
    updated_by: updatedBy,
    access_token: null,
    has_access_token: false,
    app_secret: null,
    has_app_secret: false,
  },
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
})

describe('PATCH /api/locations/[id]/channels/[connId] — the legitimate flow is byte-identical', () => {
  it('a manager editing their own studio gets exactly the masked body they always did', async () => {
    const res = await PATCH(patchReq(LOC_A, CONN, VALID), props(LOC_A, CONN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_A, 'u1'))
  })

  it('sweeps the other active row for the platform, then updates constrained by id AND location', async () => {
    await PATCH(patchReq(LOC_A, CONN, VALID), props(LOC_A, CONN))
    expect(db.writes.map(w => w.op)).toEqual(['update', 'update'])
    expect(db.writes[0].filters).toEqual({ location_id: LOC_A, platform: 'instagram', is_active: true, not_id: CONN })
    expect(db.writes[1].filters).toEqual({ id: CONN, location_id: LOC_A })
    expect(db.writes[1].patch.updated_by).toBe('u1')
  })

  it('404s when the connection does not belong to this location (unchanged), writing nothing', async () => {
    createServerClient.mockReturnValue(db = makeDb({ existing: null }))
    const res = await PATCH(patchReq(LOC_A, CONN, VALID), props(LOC_A, CONN))
    expect(res.status).toBe(404)
    expect(db.writes).toEqual([])
  })
})

describe('PATCH /api/locations/[id]/channels/[connId] — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await PATCH(patchReq(LOC_B, CONN, { agent_enabled: true }), props(LOC_B, CONN))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await PATCH(patchReq(LOC_B, CONN, VALID), props(LOC_B, CONN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u3'))
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PATCH(patchReq(LOC_B, CONN, VALID), props(LOC_B, CONN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u5'))
  })

  it('(d) 403s a non-member on the MEMBERSHIP copy, not the generic Forbidden', async () => {
    const res = await PATCH(patchReq(LOC_B, CONN, VALID), props(LOC_B, CONN))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PATCH(patchReq(LOC_A, CONN, VALID), props(LOC_A, CONN))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
  })

  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await PATCH(patchReq(LOC_B, CONN, VALID), props(LOC_B, CONN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u4'))
  })
})

describe('DELETE /api/locations/[id]/channels/[connId] — the gate is the role AT THE TARGET studio', () => {
  it('a manager deleting at their own studio gets exactly the body they always did', async () => {
    const res = await DELETE(delReq(LOC_A, CONN), props(LOC_A, CONN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: CONN, location_id: LOC_A } }])
  })

  it('(a) refuses a manager-at-A who is plain STAFF at the target B, deleting nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await DELETE(delReq(LOC_B, CONN), props(LOC_B, CONN))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await DELETE(delReq(LOC_B, CONN), props(LOC_B, CONN))
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: CONN, location_id: LOC_B } }])
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await DELETE(delReq(LOC_B, CONN), props(LOC_B, CONN))).status).toBe(200)
    expect(db.writes).toHaveLength(1)
  })

  it('(d) 403s a non-member on the MEMBERSHIP copy, deleting nothing', async () => {
    const res = await DELETE(delReq(LOC_B, CONN), props(LOC_B, CONN))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) 401s an anonymous caller without deleting', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await DELETE(delReq(LOC_A, CONN), props(LOC_A, CONN))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
  })

  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    expect((await DELETE(delReq(LOC_B, CONN), props(LOC_B, CONN))).status).toBe(200)
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: CONN, location_id: LOC_B } }])
  })
})

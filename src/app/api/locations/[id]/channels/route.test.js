// LOCFIX-ROLEGATE.1 — POST /api/locations/[id]/channels creates a channel
// connection (Instagram / Messenger creds, incl. an access token and an app
// secret) on the PATH-PARAM location.
//
// THE GATE IS THE POINT. The old gate was ONE boolean —
//   user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)
// — and `user.role` resolves at the caller's ACTIVE location (with auth.js's
// highest-role-anywhere fallback). So a manager at studio A who is plain
// STAFF at studio B could POST /api/locations/<B>/channels and attach their
// own Instagram account to B, taking over B's DMs, with a 200. The boolean is
// now split into the two questions it was conflating: membership
// (assertLocationAccess) and the role AT THE TARGET (hasRoleAtLocation +
// MANAGER_ROLES).
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

import { GET, POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

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
const STAFF_A = {
  id: 'u6', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'staff' },
  activeLocation: { id: LOC_A },
}

// The route's shapes against channel_connections, modelled honestly:
//   POST .update({is_active:false}).eq×3        (bare await — the one-active sweep)
//        .insert(row).select().single()          → echoes the inserted row
//   GET  .select('*').eq('location_id').order().order()
// Echoing the inserted row back means pinning the success BODY also pins the
// WRITE. Fail LOUD on any other table or any other chain.
function makeDb({ rows = [] } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'channel_connections') throw new Error(`unexpected db.from('${table}') in channels test`)
      return {
        update(patch) {
          const filters = {}
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            then: (res, rej) => {
              writes.push({ op: 'update', patch, filters })
              return Promise.resolve({ data: null, error: null }).then(res, rej)
            },
          }
          return builder
        },
        insert(row) {
          writes.push({ op: 'insert', row })
          return { select: () => ({ single: () => Promise.resolve({ data: { id: 'conn-1', ...row }, error: null }) }) }
        },
        select() {
          let out = rows
          const builder = {
            eq(col, val) {
              if (col !== 'location_id') throw new Error(`unexpected .eq('${col}') in channels GET`)
              out = out.filter(r => r.location_id === val)
              return builder
            },
            order: () => builder,
            then: (res, rej) => Promise.resolve({ data: out, error: null }).then(res, rej),
          }
          return builder
        },
      }
    },
  }
}

const props = (id) => ({ params: { id } })
const post = (id, body) => new Request(`http://localhost/api/locations/${id}/channels`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/channels`)

const VALID = { platform: 'instagram', label: 'Studio IG', access_token: 'IGTOKENabcdef123456' }

// The exact body the channels card parses today — the masked shape, pinned as
// a literal rather than rebuilt from maskConnectionRow, so a change to the
// shape is a diff here and not a silently re-derived expectation.
const successBody = (locationId, updatedBy) => ({
  success: true,
  connection: {
    id: 'conn-1',
    location_id: locationId,
    updated_by: updatedBy,
    platform: 'instagram',
    label: 'Studio IG',
    is_active: true,
    token_expires_at: null,
    token_refreshed_at: null,
    access_token: '••••••123456',
    has_access_token: true,
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

describe('POST /api/locations/[id]/channels — the legitimate flow is byte-identical', () => {
  it('a manager connecting their own studio gets exactly the masked body they always did', async () => {
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_A, 'u1'))
  })

  it('sweeps the previous active row for the platform, then inserts against the target location', async () => {
    await POST(post(LOC_A, VALID), props(LOC_A))
    expect(db.writes.map(w => w.op)).toEqual(['update', 'insert'])
    expect(db.writes[0].filters).toEqual({ location_id: LOC_A, platform: 'instagram', is_active: true })
    expect(db.writes[1].row.location_id).toBe(LOC_A)
    expect(db.writes[1].row.updated_by).toBe('u1')
  })

  it('400s an unsupported platform without writing (unchanged)', async () => {
    const res = await POST(post(LOC_A, { platform: 'tiktok' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })
})

describe('POST /api/locations/[id]/channels — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u3'))
    expect(db.writes[1].row.location_id).toBe(LOC_B)
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u5'))
  })

  // The intended copy change: the membership half now answers
  // assertLocationAccess's own message instead of the generic "Forbidden".
  it('(d) 403s a non-member on the MEMBERSHIP copy, not the generic Forbidden', async () => {
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.writes).toEqual([])
  })

  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(successBody(LOC_B, 'u4'))
  })

  it('403s plain staff at their OWN studio on the ROLE copy, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
    expect(db.writes).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, { nonsense: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })
})

// The read side is untouched by LOCFIX-ROLEGATE.1 (membership only, secrets
// masked) — pinned so the rework cannot quietly narrow or widen it.
describe('GET /api/locations/[id]/channels — unchanged: membership only, secrets masked', () => {
  it('a plain staff member of the target lists it, with the token masked', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A)
    createServerClient.mockReturnValue(makeDb({ rows: [
      { id: 'c1', location_id: LOC_A, platform: 'instagram', access_token: 'IGTOKENabcdef123456' },
      { id: 'c2', location_id: LOC_B, platform: 'instagram', access_token: 'OTHERSTUDIO' },
    ] }))
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0].id).toBe('c1')
    expect(body.connections[0].access_token).toBe('••••••123456')
    expect(body.connections[0].has_access_token).toBe(true)
  })

  it('403s a non-member and 401s an anonymous caller', async () => {
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(401)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { DEFAULT_GATE_COPY } from '@/lib/geofence-attendance'

beforeEach(() => vi.clearAllMocks())

// Next 16 handler props — `await props.params` works on a plain object.
const props = { params: { id: 'loc1' } }

function putReq(body) {
  return new Request('http://x/api/locations/loc1/geofence-attendance', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const getReq = () => new Request('http://x/api/locations/loc1/geofence-attendance')

// assertLocationAccess reads user.locations; guardMasterOrOwner (the gate
// since MAILFIX-BRANDGATE.2) reads user.profileRole + user.rolesByLocation.
// `role` is the active-location-resolved value the OLD gate trusted — kept so
// a regression back to `user.role` is visible. withRole() keeps every field
// honest at once: the same role everywhere, at the one studio the user holds.
const owner = {
  id: 'u', role: 'owner', profileRole: 'owner', isMaster: false,
  activeLocation: { id: 'loc1' }, locations: [{ id: 'loc1' }],
  rolesByLocation: { loc1: 'owner' },
}
const withRole = (role) => ({ ...owner, role, profileRole: role, rolesByLocation: { loc1: role } })

const validBody = {
  enabled: true,
  latitude: 53.2905,
  longitude: -6.1988,
  radius_m: 200,
  gate_copy: null,
}

// Locations row select + captured merge-write, scoring-test style.
function mockDb(existingSettings = {}) {
  let written = null
  createServerClient.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'loc1', settings: existingSettings }, error: null }) }) }),
      update: (patch) => {
        written = patch
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'loc1', settings: patch.settings }, error: null }) }) }) }
      },
    }),
  })
  return () => written
}

describe('GET /api/locations/[id]/geofence-attendance', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(getReq(), props)).status).toBe(401)
  })

  it('returns the defaulted blob for empty settings (can_edit for owner)', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb({})
    const body = await (await GET(getReq(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual({
      enabled: false,
      latitude: null,
      longitude: null,
      radius_m: 150,
      gate_copy: DEFAULT_GATE_COPY,
      can_edit: true,
    })
  })

  it('can_edit=false for a manager (read still allowed)', async () => {
    getCurrentUser.mockResolvedValue(withRole('manager'))
    mockDb({})
    const body = await (await GET(getReq(), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.can_edit).toBe(false)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — auth gate', () => {
  it('401 when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PUT(putReq(validBody), props)).status).toBe(401)
  })

  it.each(['staff', 'head_coach', 'manager'])('403 for %s (owner + master only)', async (role) => {
    getCurrentUser.mockResolvedValue(withRole(role))
    expect((await PUT(putReq(validBody), props)).status).toBe(403)
  })

  it('200 for an owner', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    expect((await PUT(putReq(validBody), props)).status).toBe(200)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — merge write', () => {
  it('writes settings.geofence without clobbering sibling settings keys', async () => {
    getCurrentUser.mockResolvedValue(owner)
    const getWritten = mockDb({ unifi: { host: 'x' } })
    const res = await PUT(putReq(validBody), props)
    expect(res.status).toBe(200)
    const written = getWritten()
    // sibling survives the merge
    expect(written.settings.unifi).toEqual({ host: 'x' })
    // and the geofence blob is stored exactly
    expect(written.settings.geofence).toEqual({
      enabled: true,
      latitude: 53.2905,
      longitude: -6.1988,
      radius_m: 200,
      gate_copy: null,
    })
  })

  it('echoes the normalised saved state', async () => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
    const body = await (await PUT(putReq(validBody), props)).json()
    expect(body.success).toBe(true)
    expect(body.data.enabled).toBe(true)
    expect(body.data.latitude).toBe(53.2905)
    expect(body.data.radius_m).toBe(200)
    // null gate_copy → the default copy comes back
    expect(body.data.gate_copy).toBe(DEFAULT_GATE_COPY)
  })
})

describe('PUT /api/locations/[id]/geofence-attendance — Zod rejection', () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(owner)
    mockDb()
  })

  it('400 on latitude 91 (out of range)', async () => {
    expect((await PUT(putReq({ ...validBody, latitude: 91 }), props)).status).toBe(400)
  })

  it('400 on longitude 181 (out of range)', async () => {
    expect((await PUT(putReq({ ...validBody, longitude: 181 }), props)).status).toBe(400)
  })

  it('400 on radius 20 (below the 50 m floor)', async () => {
    expect((await PUT(putReq({ ...validBody, radius_m: 20 }), props)).status).toBe(400)
  })

  it('400 when enabled without coordinates (refine)', async () => {
    expect((await PUT(putReq({ ...validBody, latitude: null }), props)).status).toBe(400)
  })

  it('disabled with null coordinates is fine', async () => {
    expect((await PUT(putReq({ enabled: false, latitude: null, longitude: null, radius_m: 150, gate_copy: null }), props)).status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// MAILFIX-BRANDGATE.2 — THE GATE IS THE ROLE AT THE TARGET STUDIO.
//
// `user.role` resolves at the caller's ACTIVE location (with a highest-role-
// anywhere fallback), while this route writes to params.id — so the old
// `canEditGeofence(user)` let an owner at studio A who is plain STAFF at
// studio B enable a geofence over B (gating every staff phone at B behind a
// background-location screen) with a 200. The gate is now membership +
// owner-or-master AT THE TARGET (assertLocationAccess then guardMasterOrOwner,
// the #1586 branding / guardMailboxAdmin order), and both run BEFORE the
// locations row is fetched, so a non-member never reaches the database. Every
// refusal asserts NO WRITE HAPPENED, not merely the status code.
//
// The legitimate flow is pinned byte-for-byte, and GET's `can_edit` is
// derived from the same target-aware predicate. The two-studio double below
// is strict where mockDb above is permissive: it answers per id, records
// every select and update, and fails loud on any other table.
// ───────────────────────────────────────────────────────────────────────────

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

const OWNER_A = {
  id: 'u1', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — owner at active A, plain staff at target B. user.role and
// profileRole both read 'owner'; neither may count at B.
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — staff at the ACTIVE studio, owner at the target.
const STAFF_A_OWNER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'owner' },
  activeLocation: { id: LOC_A },
}
const MANAGER_A = {
  id: 'u4', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// Masters have no per-location rows — profileRole alone must carry them.
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

function makeDb({ rows = [] } = {}) {
  const selects = []
  const updates = []
  const rowFor = (id) => rows.find((r) => r.id === id) || null
  return {
    selects,
    updates,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in geofence-attendance test`)
      return {
        select(cols) {
          return {
            eq: (col, id) => {
              if (col !== 'id') throw new Error(`unexpected .eq('${col}') in geofence-attendance read`)
              selects.push({ cols, id })
              const row = rowFor(id)
              return {
                single: () => Promise.resolve(row
                  ? { data: { id: row.id, settings: row.settings }, error: null }
                  : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }),
              }
            },
          }
        },
        update(patch) {
          return {
            eq: (col, id) => {
              if (col !== 'id') throw new Error(`unexpected .eq('${col}') in geofence-attendance write`)
              updates.push({ id, patch })
              return {
                select: () => ({ single: () => Promise.resolve({ data: { id, settings: patch.settings }, error: null }) }),
              }
            },
          }
        },
      }
    },
  }
}

const propsFor = (id) => ({ params: { id } })
const putAt = (id, body) => new Request(`http://localhost/api/locations/${id}/geofence-attendance`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const getAt = (id) => new Request(`http://localhost/api/locations/${id}/geofence-attendance`)

const ROWS = [
  { id: LOC_A, settings: { unifi: { host: 'a.local' } } },
  { id: LOC_B, settings: { unifi: { host: 'b.local' }, geofence: { enabled: true, latitude: 53.34, longitude: -6.26, radius_m: 100, gate_copy: null } } },
]

// The exact body the settings card parses today. Pinned as a literal, not
// rebuilt from the route's own helpers.
const SUCCESS_BODY = {
  success: true,
  data: {
    enabled: true,
    latitude: 53.2905,
    longitude: -6.1988,
    radius_m: 200,
    gate_copy: DEFAULT_GATE_COPY,
    can_edit: true,
  },
}

describe('PUT /api/locations/[id]/geofence-attendance — the gate is the role AT THE TARGET studio', () => {
  let db
  beforeEach(() => {
    db = makeDb({ rows: ROWS })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(OWNER_A)
  })

  it('an owner saving their own studio gets exactly the success body they always did', async () => {
    const res = await PUT(putAt(LOC_A, validBody), propsFor(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.updates[0].patch.settings.unifi).toEqual({ host: 'a.local' })
  })

  it('(a) refuses an owner-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(putAt(LOC_B, validBody), propsFor(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit geofence attendance.')
    expect(db.updates).toEqual([])
  })

  it('(b) lets an owner AT THE TARGET through, byte-identical, even with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await PUT(putAt(LOC_B, validBody), propsFor(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.updates[0].id).toBe(LOC_B)
    // B's own sibling key survives — the merge read B's row, not A's.
    expect(db.updates[0].patch.settings.unifi).toEqual({ host: 'b.local' })
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(putAt(LOC_B, validBody), propsFor(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.updates[0].id).toBe(LOC_B)
  })

  it('(d) 403s a non-member on the MEMBERSHIP message before touching the database', async () => {
    const res = await PUT(putAt(LOC_B, validBody), propsFor(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/location/i)
    expect(db.selects).toEqual([])
    expect(db.updates).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(putAt(LOC_A, validBody), propsFor(LOC_A))
    expect(res.status).toBe(401)
    expect(db.updates).toEqual([])
  })

  it('403s a manager at the target without writing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(putAt(LOC_A, validBody), propsFor(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit geofence attendance.')
    expect(db.updates).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(putAt(LOC_B, { nonsense: true }), propsFor(LOC_B))
    expect(res.status).toBe(403)
    expect(db.updates).toEqual([])
  })

  it('404s a member whose studio row is missing, writing nothing (unchanged)', async () => {
    createServerClient.mockReturnValue(makeDb({ rows: [] }))
    expect((await PUT(putAt(LOC_A, validBody), propsFor(LOC_A))).status).toBe(404)
  })
})

describe('GET /api/locations/[id]/geofence-attendance — can_edit is the role AT THE TARGET studio', () => {
  let db
  beforeEach(() => {
    db = makeDb({ rows: ROWS })
    createServerClient.mockReturnValue(db)
    getCurrentUser.mockResolvedValue(OWNER_A)
  })

  it('surfaces the saved geofence for the target studio', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const body = await (await GET(getAt(LOC_B), propsFor(LOC_B))).json()
    expect(body.data).toEqual({
      enabled: true, latitude: 53.34, longitude: -6.26, radius_m: 100, gate_copy: DEFAULT_GATE_COPY, can_edit: true,
    })
  })

  it('an owner-at-A who is staff at B reads B with can_edit FALSE — the card must not offer a Save that 403s', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const body = await (await GET(getAt(LOC_B), propsFor(LOC_B))).json()
    expect(body.success).toBe(true)
    expect(body.data.can_edit).toBe(false)
  })

  it("B's actual owner reads B with can_edit TRUE even while their active studio is A", async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const body = await (await GET(getAt(LOC_B), propsFor(LOC_B))).json()
    expect(body.data.can_edit).toBe(true)
  })

  it('a master reads with can_edit true; a non-member is 403d (unchanged)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await (await GET(getAt(LOC_B), propsFor(LOC_B))).json()).data.can_edit).toBe(true)
    getCurrentUser.mockResolvedValue(OWNER_A)
    expect((await GET(getAt(LOC_B), propsFor(LOC_B))).status).toBe(403)
  })
})

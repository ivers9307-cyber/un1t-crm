// MAILFIX-BRANDGATE.2 — PUT /api/locations/[id]/comms-frequency-cap writes a
// studio's cross-channel marketing frequency cap
// (locations.settings.comms_frequency_cap), keyed by the PATH PARAM location
// id. When enabled it changes what every campaign, broadcast and sequence
// step at that studio does.
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with a highest-role-anywhere fallback), while this route writes to
// params.id — so the old `canEditFrequencyCap(user)` let an owner at studio A
// who is plain STAFF at studio B switch B's cap on or off with a 200. The gate
// is now membership + owner-or-master AT THE TARGET (assertLocationAccess then
// guardMasterOrOwner — the #1586 branding / guardMailboxAdmin order), and both
// run BEFORE the locations row is fetched, so a non-member never reaches the
// database and can no longer tell an existing studio (403) from a missing one
// (404). Every refusal asserts NO WRITE HAPPENED, not merely the status code.
//
// The legitimate flow is pinned byte-for-byte: an owner acting on their own
// studio gets exactly the success body they got before this rework, and an
// owner of B whose ACTIVE studio is A gets that same body (the old gate 403'd
// them, which is the mirror image of the same bug).
//
// GET's `can_edit` is derived from the same target-aware predicate, so the
// settings card can no longer offer a Save that 403s (owner-at-A/staff-at-B)
// or hide the editor from B's actual owner (staff-at-A/owner-at-B). GET's
// fetch-then-membership order is otherwise untouched.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so the real guards' contracts are what run here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET, PUT } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'

// assertLocationAccess reads user.locations; guardMasterOrOwner reads
// user.profileRole + user.rolesByLocation[locationId]. `role` and `isMaster`
// are the active-location-resolved values the OLD gate trusted — kept on
// every fixture so a regression back to `user.role` is visible.
const OWNER_A = {
  id: 'u1', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'owner' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — owner at their active studio A, plain staff at B. Their
// `user.role` is 'owner' (resolved at A), so the old gate waved them through
// to write B. profileRole is 'owner' too (estate role), which must NOT count:
// only 'master' bypasses the per-location check.
const OWNER_A_STAFF_B = {
  id: 'u2', role: 'owner', profileRole: 'owner', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — staff at the ACTIVE studio, owner at the target. The old
// gate refused them (user.role = 'staff'); the target-role gate lets them in,
// which is what "owner of studio B" is supposed to mean.
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
// getCurrentUser hands a master EVERY active location, so membership passes.
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// The route's two shapes against `locations`, modelled honestly:
//   read   .select(cols).eq('id', id).single()             → the seeded row, or a
//                                                            PostgREST-style miss
//   write  .update(patch).eq('id', id).select(cols).single() → echoes the patch
// Echoing the written settings back means pinning the success BODY also pins
// the WRITE. Every select and update is recorded so a refusal can assert the
// database was never reached. Fail LOUD on any other table.
function makeDb({ rows = [] } = {}) {
  const selects = []
  const updates = []
  const rowFor = (id) => rows.find((r) => r.id === id) || null
  return {
    selects,
    updates,
    from(table) {
      if (table !== 'locations') throw new Error(`unexpected db.from('${table}') in comms-frequency-cap test`)
      return {
        select(cols) {
          return {
            eq: (col, id) => {
              if (col !== 'id') throw new Error(`unexpected .eq('${col}') in comms-frequency-cap read`)
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
              if (col !== 'id') throw new Error(`unexpected .eq('${col}') in comms-frequency-cap write`)
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

// Next 16 handler props — `await props.params` works on a plain object.
const props = (id) => ({ params: { id } })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/comms-frequency-cap`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/comms-frequency-cap`)

const VALID = { enabled: true, min_hours_between: 48 }

// Both studios exist, each carrying a sibling settings key the merge must
// not clobber.
const ROWS = [
  { id: LOC_A, settings: { unifi: { host: 'a.local' } } },
  { id: LOC_B, settings: { unifi: { host: 'b.local' }, comms_frequency_cap: { enabled: true, min_hours_between: 12 } } },
]

// The exact body the settings card parses today. Pinned as a literal, not
// rebuilt from the route's own helpers, so a change to the shape is a diff
// here and not a silently re-derived expectation.
const SUCCESS_BODY = {
  success: true,
  data: { enabled: true, min_hours_between: 48, can_edit: true },
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb({ rows: ROWS })
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('PUT /api/locations/[id]/comms-frequency-cap — the legitimate flow is byte-identical', () => {
  it('an owner saving their own studio gets exactly the success body they always did', async () => {
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
  })

  it('merges into settings without clobbering sibling keys, and stamps updated_at', async () => {
    await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]).toEqual({
      id: LOC_A,
      patch: {
        settings: { unifi: { host: 'a.local' }, comms_frequency_cap: { enabled: true, min_hours_between: 48 } },
        updated_at: expect.any(String),
      },
    })
  })

  it('400s an out-of-range window without writing (unchanged)', async () => {
    const res = await PUT(put(LOC_A, { enabled: true, min_hours_between: 169 }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.updates).toEqual([])
  })

  it('404s a member whose studio row is missing, writing nothing (unchanged)', async () => {
    createServerClient.mockReturnValue(makeDb({ rows: [] }))
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/locations/[id]/comms-frequency-cap — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses an owner-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { enabled: false, min_hours_between: 1 }), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit the marketing frequency cap.')
    expect(db.updates).toEqual([])
  })

  it('(b) lets an owner AT THE TARGET through, byte-identical, even with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.updates[0].id).toBe(LOC_B)
    // B's own sibling key survives — the merge read B's row, not A's.
    expect(db.updates[0].patch.settings.unifi).toEqual({ host: 'b.local' })
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.updates[0].id).toBe(LOC_B)
  })

  it('(d) 403s a non-member on the MEMBERSHIP message before touching the database', async () => {
    // Owner of A only, aiming at B: assertLocationAccess answers first
    // (guardMailboxAdmin order) so they are told "not one of your locations",
    // and no row is fetched — a non-member can no longer tell 403 from 404.
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/location/i)
    expect(db.selects).toEqual([])
    expect(db.updates).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.updates).toEqual([])
  })

  it('403s a manager at the target without writing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit the marketing frequency cap.')
    expect(db.updates).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { nonsense: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.updates).toEqual([])
  })
})

describe('GET /api/locations/[id]/comms-frequency-cap — can_edit is the role AT THE TARGET studio', () => {
  it('an owner reading their own studio sees the OFF default and can_edit true', async () => {
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { enabled: false, min_hours_between: 24, can_edit: true },
    })
  })

  it('surfaces the saved cap for the target studio', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const body = await (await GET(get(LOC_B), props(LOC_B))).json()
    expect(body.data).toEqual({ enabled: true, min_hours_between: 12, can_edit: true })
  })

  it('an owner-at-A who is staff at B reads B with can_edit FALSE — the card must not offer a Save that 403s', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const body = await (await GET(get(LOC_B), props(LOC_B))).json()
    expect(body.success).toBe(true)
    expect(body.data.can_edit).toBe(false)
  })

  it("B's actual owner reads B with can_edit TRUE even while their active studio is A", async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const body = await (await GET(get(LOC_B), props(LOC_B))).json()
    expect(body.data.can_edit).toBe(true)
  })

  it('a manager reads with can_edit false; a master with can_edit true', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    expect((await (await GET(get(LOC_A), props(LOC_A))).json()).data.can_edit).toBe(false)
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await (await GET(get(LOC_B), props(LOC_B))).json()).data.can_edit).toBe(true)
  })

  it('403s a non-member, 401s an anonymous caller, 404s a missing row (all unchanged)', async () => {
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(401)
    getCurrentUser.mockResolvedValue(OWNER_A)
    createServerClient.mockReturnValue(makeDb({ rows: [] }))
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(404)
  })
})

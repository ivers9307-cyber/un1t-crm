// MAILFIX-BRANDGATE.2 — PUT /api/locations/[id]/send-quiet-hours writes a
// studio's send-time quiet window (company_settings.send_quiet_hours_*),
// keyed by the PATH PARAM location id.
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with a highest-role-anywhere fallback), while this route writes to
// params.id — so the old `canEditQuietHours(user)` let an owner at studio A
// who is plain STAFF at studio B change when B's messages may send, with a
// 200. The gate is now membership + owner-or-master AT THE TARGET
// (assertLocationAccess then guardMasterOrOwner — the #1586 branding /
// guardMailboxAdmin order). Every refusal asserts NO WRITE HAPPENED, not
// merely the status code.
//
// The legitimate flow is pinned byte-for-byte: an owner acting on their own
// studio gets exactly the success body they got before this rework, and an
// owner of B whose ACTIVE studio is A gets that same body (the old gate 403'd
// them, which is the mirror image of the same bug).
//
// GET's `can_edit` is derived from the same target-aware predicate, so the
// settings card can no longer offer a Save that 403s (owner-at-A/staff-at-B)
// or hide the editor from B's actual owner (staff-at-A/owner-at-B).
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
import { DEFAULT_SEND_QUIET_HOURS } from '@/lib/send-quiet-hours'

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

const COLS = ['send_quiet_hours_enabled', 'send_quiet_hours_start', 'send_quiet_hours_end']

// The route's two shapes against company_settings, modelled honestly:
//   PUT  .upsert(payload, opts).select(cols).single()  → echoes the written cols
//   GET  .select(cols).eq('location_id', id).limit(1)  → the seeded rows
// Echoing the written columns back means pinning the success BODY also pins
// the WRITE. Fail LOUD on any other table or any other chain.
function makeDb({ rows = [] } = {}) {
  const upserts = []
  return {
    upserts,
    from(table) {
      if (table !== 'company_settings') throw new Error(`unexpected db.from('${table}') in send-quiet-hours test`)
      return {
        upsert(payload, opts) {
          upserts.push({ payload, opts })
          const echoed = Object.fromEntries(COLS.map((c) => [c, payload[c]]))
          return {
            select: () => ({ single: () => Promise.resolve({ data: echoed, error: null }) }),
          }
        },
        select() {
          return {
            eq: (col, val) => {
              if (col !== 'location_id') throw new Error(`unexpected .eq('${col}') in send-quiet-hours GET`)
              return { limit: () => Promise.resolve({ data: rows.filter((r) => r.location_id === val), error: null }) }
            },
          }
        },
      }
    },
  }
}

// Next 16 handler props — `await props.params` works on a plain object.
const props = (id) => ({ params: { id } })
const put = (id, body) => new Request(`http://localhost/api/locations/${id}/send-quiet-hours`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/send-quiet-hours`)

const VALID = { enabled: true, start_hour: 22, end_hour: 7 }

// The exact body the settings card parses today. Pinned as a literal, not
// rebuilt from the route's own helpers, so a change to the shape is a diff
// here and not a silently re-derived expectation.
const SUCCESS_BODY = {
  success: true,
  data: {
    enabled: true,
    start_hour: 22,
    end_hour: 7,
    default_start_hour: DEFAULT_SEND_QUIET_HOURS.startHour,
    default_end_hour: DEFAULT_SEND_QUIET_HOURS.endHour,
    can_edit: true,
  },
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(OWNER_A)
})

describe('PUT /api/locations/[id]/send-quiet-hours — the legitimate flow is byte-identical', () => {
  it('an owner saving their own studio gets exactly the success body they always did', async () => {
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
  })

  it('writes ONLY the three quiet-hours columns plus the audit stamp, keyed on location_id', async () => {
    await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(db.upserts).toHaveLength(1)
    const { payload, opts } = db.upserts[0]
    expect(payload).toEqual({
      location_id: LOC_A,
      send_quiet_hours_enabled: true,
      send_quiet_hours_start: 22,
      send_quiet_hours_end: 7,
      updated_at: expect.any(String),
      updated_by: 'u1',
    })
    expect(opts).toEqual({ onConflict: 'location_id' })
  })

  it('switching quiet hours off is stored and echoed as disabled', async () => {
    const res = await PUT(put(LOC_A, { enabled: false, start_hour: 21, end_hour: 8 }), props(LOC_A))
    expect(res.status).toBe(200)
    expect(db.upserts[0].payload.send_quiet_hours_enabled).toBe(false)
    expect((await res.json()).data.enabled).toBe(false)
  })

  it('400s a zero-length window (start === end) without writing (unchanged)', async () => {
    const res = await PUT(put(LOC_A, { enabled: true, start_hour: 9, end_hour: 9 }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.upserts).toEqual([])
  })
})

describe('PUT /api/locations/[id]/send-quiet-hours — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses an owner-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { enabled: false, start_hour: 0, end_hour: 1 }), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit send quiet hours.')
    expect(db.upserts).toEqual([])
  })

  it('(b) lets an owner AT THE TARGET through, byte-identical, even with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_OWNER_B)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.upserts[0].payload.location_id).toBe(LOC_B)
    expect(db.upserts[0].payload.updated_by).toBe('u3')
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SUCCESS_BODY)
    expect(db.upserts[0].payload.location_id).toBe(LOC_B)
  })

  it('(d) 403s a non-member on the MEMBERSHIP message, not a role complaint that confirms the studio exists', async () => {
    // Owner of A only, aiming at B: assertLocationAccess answers first
    // (guardMailboxAdmin order) so they are told "not one of your locations".
    const res = await PUT(put(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/location/i)
    expect(db.upserts).toEqual([])
  })

  it('(e) 401s an anonymous caller without writing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(401)
    expect(db.upserts).toEqual([])
  })

  it('403s a manager at the target without writing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await PUT(put(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only owners and masters can edit send quiet hours.')
    expect(db.upserts).toEqual([])
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(OWNER_A_STAFF_B)
    const res = await PUT(put(LOC_B, { nonsense: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.upserts).toEqual([])
  })
})

describe('GET /api/locations/[id]/send-quiet-hours — can_edit is the role AT THE TARGET studio', () => {
  it('an owner reading their own studio sees can_edit true and the defaults when no row exists', async () => {
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: {
        enabled: DEFAULT_SEND_QUIET_HOURS.enabled,
        start_hour: DEFAULT_SEND_QUIET_HOURS.startHour,
        end_hour: DEFAULT_SEND_QUIET_HOURS.endHour,
        default_start_hour: DEFAULT_SEND_QUIET_HOURS.startHour,
        default_end_hour: DEFAULT_SEND_QUIET_HOURS.endHour,
        can_edit: true,
      },
    })
  })

  it('surfaces the saved row for the target studio', async () => {
    createServerClient.mockReturnValue(makeDb({ rows: [
      { location_id: LOC_A, send_quiet_hours_enabled: true, send_quiet_hours_start: 23, send_quiet_hours_end: 6 },
      { location_id: LOC_B, send_quiet_hours_enabled: false, send_quiet_hours_start: 20, send_quiet_hours_end: 9 },
    ] }))
    const body = await (await GET(get(LOC_A), props(LOC_A))).json()
    expect(body.data).toMatchObject({ enabled: true, start_hour: 23, end_hour: 6 })
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

  it('403s a non-member and 401s an anonymous caller (unchanged)', async () => {
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(401)
  })
})

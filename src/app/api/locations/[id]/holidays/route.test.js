// LOCFIX-ROLEGATE.1 — POST /api/locations/[id]/holidays writes a CUSTOM
// holiday row for the PATH-PARAM location.
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with auth.js's highest-role-anywhere fallback), while this route writes to
// params.id — so the old `MANAGER_ROLES.includes(user.role)` check let a
// manager at studio A who is plain STAFF at studio B send
//   POST /api/locations/<B>/holidays { date, name }
// and close B's calendar day, with a 201. Membership was the only thing
// judged at the target. The gate is now membership (assertLocationAccess)
// then the role AT THE TARGET (hasRoleAtLocation + MANAGER_ROLES).
//
// TIER A: this route's list is MANAGER_ROLES, which INCLUDES head_coach —
// pinned below, and deliberately different from the stripe-connect routes'
// narrower ['master','owner','manager'].
//
// Every refusal asserts NO WRITE HAPPENED, not merely the status code.
//
// @/lib/auth is the REAL module (importActual) with only getCurrentUser
// mocked, so the real guards' contracts are what run here.

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

// assertLocationAccess reads user.locations; hasRoleAtLocation reads
// user.profileRole + user.rolesByLocation[locationId]. `role` and `isMaster`
// are the active-location-resolved values the OLD gate trusted — kept on
// every fixture so a regression back to `user.role` is visible.
const MANAGER_A = {
  id: 'u1', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' },
  activeLocation: { id: LOC_A },
}
// THE AUDIT CAST — manager at their active studio A, plain staff at B.
// Their `user.role` is 'manager' (resolved at A), so the old gate waved them
// through to write B. profileRole is 'manager' too, which must NOT count:
// only 'master' bypasses the per-location check.
const MANAGER_A_STAFF_B = {
  id: 'u2', role: 'manager', profileRole: 'manager', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'manager', [LOC_B]: 'staff' },
  activeLocation: { id: LOC_A },
}
// The mirror image — staff at the ACTIVE studio, manager at the target. The
// old gate refused them (user.role = 'staff'); the target-role gate lets them
// in, which is what "manager of studio B" is supposed to mean.
const STAFF_A_MANAGER_B = {
  id: 'u3', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'manager' },
  activeLocation: { id: LOC_A },
}
// TIER A includes head_coach. This fixture is half of the pair that pins the
// two tiers apart (the stripe-connect twin of it must be REFUSED).
const STAFF_A_HEAD_COACH_B = {
  id: 'u4', role: 'staff', profileRole: 'staff', isMaster: false,
  locations: [{ id: LOC_A }, { id: LOC_B }],
  rolesByLocation: { [LOC_A]: 'staff', [LOC_B]: 'head_coach' },
  activeLocation: { id: LOC_A },
}
// Masters have no per-location rows — profileRole alone must carry them.
// getCurrentUser hands a master EVERY active location, so membership passes.
const MASTER = {
  id: 'u5', role: 'master', profileRole: 'master', isMaster: true,
  locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: {},
  activeLocation: { id: LOC_A },
}

// The route's shapes against the two tables, modelled honestly:
//   POST .upsert(payload, opts).select(cols).single()  → echoes the row
//   GET  locations.select('country').eq('id').single()
//        location_holidays.select(...).eq(...).order(...)[.gte][.lte]
// Echoing the written columns back means pinning the success BODY also pins
// the WRITE. Fail LOUD on any other table or any other chain.
function makeDb({ custom = [], country = 'IE' } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      if (table === 'locations') {
        return {
          select(cols) {
            if (cols !== 'country') throw new Error(`unexpected locations.select('${cols}') in holidays test`)
            return { eq: () => ({ single: () => Promise.resolve({ data: { country }, error: null }) }) }
          },
        }
      }
      if (table !== 'location_holidays') throw new Error(`unexpected db.from('${table}') in holidays test`)
      return {
        upsert(payload, opts) {
          writes.push({ op: 'upsert', payload, opts })
          return {
            select: () => ({
              single: () => Promise.resolve({
                data: { id: 'hol-1', location_id: payload.location_id, date: payload.date, name: payload.name },
                error: null,
              }),
            }),
          }
        },
        select() {
          let rows = custom
          const builder = {
            eq(col, val) {
              if (col !== 'location_id') throw new Error(`unexpected .eq('${col}') in holidays GET`)
              rows = rows.filter(r => r.location_id === val)
              return builder
            },
            order: () => builder,
            gte: () => builder,
            lte: () => builder,
            then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
          }
          return builder
        },
      }
    },
  }
}

// Next 16 handler props — `await props.params` works on a plain object.
const props = (id) => ({ params: { id } })
const post = (id, body) => new Request(`http://localhost/api/locations/${id}/holidays`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (id) => new Request(`http://localhost/api/locations/${id}/holidays`)

const VALID = { date: '2026-12-25', name: 'Christmas Day' }

// The exact body the holidays card parses today. Pinned as a literal so a
// change to the shape is a diff here, not a silently re-derived expectation.
const successBody = (locationId) => ({
  success: true,
  data: { id: 'hol-1', location_id: locationId, date: '2026-12-25', name: 'Christmas Day', source: 'custom' },
})

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
})

describe('POST /api/locations/[id]/holidays — the legitimate flow is byte-identical', () => {
  it('a manager adding a holiday at their own studio gets exactly the 201 body they always did', async () => {
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(successBody(LOC_A))
  })

  it('writes the row keyed on (location_id, date) with the caller as created_by', async () => {
    await POST(post(LOC_A, VALID), props(LOC_A))
    expect(db.writes).toHaveLength(1)
    expect(db.writes[0].payload).toEqual({
      location_id: LOC_A, date: '2026-12-25', name: 'Christmas Day', created_by: 'u1',
    })
    expect(db.writes[0].opts).toEqual({ onConflict: 'location_id,date' })
  })

  it('400s a malformed date without writing (unchanged)', async () => {
    const res = await POST(post(LOC_A, { date: 'not-a-date', name: 'X' }), props(LOC_A))
    expect(res.status).toBe(400)
    expect(db.writes).toEqual([])
  })
})

describe('POST /api/locations/[id]/holidays — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, writing nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Unauthorized')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through, byte-identical, with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(successBody(LOC_B))
    expect(db.writes[0].payload.location_id).toBe(LOC_B)
    expect(db.writes[0].payload.created_by).toBe('u3')
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(successBody(LOC_B))
  })

  it('(d) 403s a non-member on the MEMBERSHIP copy, not a role complaint', async () => {
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) refuses an anonymous caller without writing, keeping this route\'s 403', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(post(LOC_A, VALID), props(LOC_A))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Unauthorized')
    expect(db.writes).toEqual([])
  })

  // TIER A — head_coach IS in MANAGER_ROLES. The stripe-connect twin of this
  // test asserts the opposite; the pair is what keeps the two tiers apart.
  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await POST(post(LOC_B, VALID), props(LOC_B))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(successBody(LOC_B))
    expect(db.writes[0].payload.location_id).toBe(LOC_B)
  })

  it('the gate answers before validation — a refused caller learns nothing about the schema', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await POST(post(LOC_B, { nonsense: true }), props(LOC_B))
    expect(res.status).toBe(403)
    expect(db.writes).toEqual([])
  })
})

// The read side is untouched by LOCFIX-ROLEGATE.1 (any member reads; no role
// tier at all) — pinned so the rework cannot quietly narrow or widen it.
describe('GET /api/locations/[id]/holidays — unchanged: membership only', () => {
  it('a plain staff member of the target reads it', async () => {
    getCurrentUser.mockResolvedValue({
      id: 'u9', role: 'staff', profileRole: 'staff', locations: [{ id: LOC_A }],
      rolesByLocation: { [LOC_A]: 'staff' }, activeLocation: { id: LOC_A },
    })
    createServerClient.mockReturnValue(makeDb({ custom: [{ id: 'h', location_id: LOC_A, date: '2026-12-27', name: 'Team day' }] }))
    const res = await GET(get(LOC_A), props(LOC_A))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.country).toBe('IE')
    expect(body.data.some(h => h.name === 'Team day' && h.source === 'custom')).toBe(true)
  })

  it('403s a non-member and 401s an anonymous caller', async () => {
    expect((await GET(get(LOC_B), props(LOC_B))).status).toBe(403)
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(get(LOC_A), props(LOC_A))).status).toBe(401)
  })
})

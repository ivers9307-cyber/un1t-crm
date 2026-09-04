// LOCFIX-ROLEGATE.1 — DELETE /api/locations/[id]/holidays/[holidayId] removes
// a CUSTOM holiday row from the PATH-PARAM location.
//
// THE GATE IS THE POINT. `user.role` resolves at the caller's ACTIVE location
// (with auth.js's highest-role-anywhere fallback), while this route deletes
// from params.id — so the old `MANAGER_ROLES.includes(user.role)` check let a
// manager at studio A who is plain STAFF at studio B send
//   DELETE /api/locations/<B>/holidays/<id>
// and re-open a day B had closed, with a 200. Membership was the only thing
// judged at the target. The gate is now membership (assertLocationAccess)
// then the role AT THE TARGET (hasRoleAtLocation + MANAGER_ROLES).
//
// TIER A: MANAGER_ROLES INCLUDES head_coach — pinned below, deliberately
// different from the stripe-connect routes' ['master','owner','manager'].
//
// Every refusal asserts NO DELETE HAPPENED, not merely the status code.
// @/lib/auth is REAL (importActual) with only getCurrentUser mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { DELETE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const HOL = 'h0000000-0000-0000-0000-0000000000f1'

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
// The mirror image — the target's real manager, whose active studio is A.
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

// .delete().eq('id', …).eq('location_id', …) — awaited as a thenable.
// The recorded filter pair IS the write log. Fail LOUD on any other table.
function makeDb() {
  const writes = []
  return {
    writes,
    from(table) {
      if (table !== 'location_holidays') throw new Error(`unexpected db.from('${table}') in holiday-delete test`)
      return {
        delete() {
          const filters = {}
          const builder = {
            eq(col, val) { filters[col] = val; return builder },
            then: (res, rej) => {
              writes.push({ op: 'delete', filters })
              return Promise.resolve({ error: null }).then(res, rej)
            },
          }
          return builder
        },
      }
    },
  }
}

const props = (id, holidayId) => ({ params: { id, holidayId } })
const del = (id, holidayId) => new Request(`http://localhost/api/locations/${id}/holidays/${holidayId}`, { method: 'DELETE' })

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(MANAGER_A)
})

describe('DELETE /api/locations/[id]/holidays/[holidayId] — the legitimate flow is byte-identical', () => {
  it('a manager deleting at their own studio gets exactly the body they always did', async () => {
    const res = await DELETE(del(LOC_A, HOL), props(LOC_A, HOL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('constrains the delete by BOTH the holiday id and the parent location', async () => {
    await DELETE(del(LOC_A, HOL), props(LOC_A, HOL))
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: HOL, location_id: LOC_A } }])
  })
})

describe('DELETE /api/locations/[id]/holidays/[holidayId] — the gate is the role AT THE TARGET studio', () => {
  it('(a) refuses a manager-at-A who is plain STAFF at the target B, deleting nothing', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    const res = await DELETE(del(LOC_B, HOL), props(LOC_B, HOL))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Unauthorized')
    expect(db.writes).toEqual([])
  })

  it('(b) lets the MANAGER AT THE TARGET through with their active studio elsewhere', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B)
    const res = await DELETE(del(LOC_B, HOL), props(LOC_B, HOL))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: HOL, location_id: LOC_B } }])
  })

  it('(c) a master passes with no per-location rows at all', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await DELETE(del(LOC_B, HOL), props(LOC_B, HOL))
    expect(res.status).toBe(200)
    expect(db.writes).toHaveLength(1)
  })

  it('(d) 403s a non-member on the MEMBERSHIP copy, not a role complaint', async () => {
    const res = await DELETE(del(LOC_B, HOL), props(LOC_B, HOL))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden — location not in your assignments')
    expect(db.writes).toEqual([])
  })

  it('(e) refuses an anonymous caller without deleting, keeping this route\'s 403', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await DELETE(del(LOC_A, HOL), props(LOC_A, HOL))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Unauthorized')
    expect(db.writes).toEqual([])
  })

  it('(f) TIER A: a HEAD COACH at the target succeeds — head_coach is in MANAGER_ROLES', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_HEAD_COACH_B)
    const res = await DELETE(del(LOC_B, HOL), props(LOC_B, HOL))
    expect(res.status).toBe(200)
    expect(db.writes).toEqual([{ op: 'delete', filters: { id: HOL, location_id: LOC_B } }])
  })
})

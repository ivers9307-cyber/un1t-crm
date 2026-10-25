// TENANTSCOPE.1 — whose devices a settings-holder may see and push to.
// Runs against the SAAS-10 two-tenant double, which REALLY filters, so a
// scope that forgot its organisation filter would pick up org B's people.

import { describe, it, expect, vi } from 'vitest'
import { loadFleetScope, inFleetScope } from './staff-fleet-scope'
import {
  makeWorld, makeTenantDb, users,
  ORG_A, LOC_A1, LOC_A2,
  P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_ORGADMIN_A,
  P_STAFF_B1, P_MASTER,
} from '../../tests/cross-tenant/fixture.js'

const A_FLEET = [P_STAFF_A1, P_MGR_A1, P_OWNER_A1, P_STAFF_A2, P_ORGADMIN_A].sort()

function spyDb(db) {
  const from = vi.fn((t) => db.from(t))
  return { ...db, from }
}

// One table answers { data: null, error } — the builder still chains.
function failing(db, table) {
  return {
    ...db,
    from(t) {
      if (t !== table) return db.from(t)
      const b = {}
      for (const m of ['select', 'eq', 'in', 'order', 'range']) b[m] = () => b
      b.then = (onF, onR) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(onF, onR)
      return b
    },
  }
}

describe('loadFleetScope', () => {
  it('a master gets the whole estate and reads nothing', async () => {
    const db = spyDb(makeTenantDb(makeWorld()))
    const scope = await loadFleetScope(db, users.master())
    expect(scope.all).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
    expect(inFleetScope(scope, P_STAFF_B1)).toBe(true)
  })

  it("a manager at A One gets org A's members AND its org admin, never org B's", async () => {
    const scope = await loadFleetScope(makeTenantDb(makeWorld()), users.managerA1())
    expect(scope.all).toBe(false)
    expect(scope.organizationId).toBe(ORG_A)
    expect([...scope.locationIds].sort()).toEqual([LOC_A1, LOC_A2].sort())
    expect([...scope.profileIds].sort()).toEqual(A_FLEET)
    expect(inFleetScope(scope, P_STAFF_B1)).toBe(false)
    expect(inFleetScope(scope, P_MASTER)).toBe(false)
  })

  it('an org admin of A gets the same fleet', async () => {
    const scope = await loadFleetScope(makeTenantDb(makeWorld()), users.orgAdminA())
    expect([...scope.profileIds].sort()).toEqual(A_FLEET)
  })

  it('a non-master with no active organisation gets nobody, and reads nothing', async () => {
    const db = spyDb(makeTenantDb(makeWorld()))
    const scope = await loadFleetScope(db, { ...users.managerA1(), activeLocation: null, activeOrganization: null })
    expect(scope).toEqual({ all: false, organizationId: null, locationIds: [], profileIds: new Set() })
    expect(db.from).not.toHaveBeenCalled()
  })

  it.each(['locations', 'profile_locations', 'profile_organizations'])(
    'a failed %s read THROWS — never an empty fleet',
    async (table) => {
      const db = failing(makeTenantDb(makeWorld()), table)
      await expect(loadFleetScope(db, users.managerA1())).rejects.toThrow(/fleet scope/)
    },
  )

  it('inFleetScope refuses everything for a missing scope', () => {
    expect(inFleetScope(null, P_STAFF_A1)).toBe(false)
  })
})

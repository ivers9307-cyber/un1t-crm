// ROLEUI.1 — the booking-type pages show Edit and Delete exactly when
// /api/bookings/event-types/[id] (PUT, DELETE) would act: a master, or
// MANAGER_ROLES at the booking type's location (ROLESWEEP.2). Same case table
// as tests/role-sweep/api-key-or-manager.test.js runs against the route.
import { describe, it, expect } from 'vitest'
import { canManageEventType, canCreateEventType } from './event-type-gates'
import { MANAGER_ROLES } from './schemas'
import { roleCases, MASTER, person, LOC_A, LOC_B } from '../../tests/helpers/role-sweep-callers.js'

describe('canManageEventType', () => {
  it.each(roleCases(MANAGER_ROLES))('%s', (_label, caller, target, outcome) => {
    expect(canManageEventType(caller, target)).toBe(outcome === 'pass')
  })

  it('a master manages a booking type with no location (the route skips the session guard for masters)', () => {
    expect(canManageEventType(MASTER, null)).toBe(true)
  })

  it('nobody else does (the route 404s it)', () => {
    expect(canManageEventType(person({ [LOC_A]: { role: 'owner' } }, LOC_A), null)).toBe(false)
    expect(canManageEventType(null, LOC_A)).toBe(false)
  })
})

// EVENTTYPERLS.1 — /bookings/event-types/new creates at the ACTIVE studio, and
// POST /api/bookings/event-types judges canManageEventType there.
describe('canCreateEventType', () => {
  const managerAStaffB = (active) => person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'staff' } }, active)

  it('a manager at the active studio may create', () => {
    expect(canCreateEventType(managerAStaffB(LOC_A))).toBe(true)
  })
  it('the same person with the studio where they are staff active may not', () => {
    expect(canCreateEventType(managerAStaffB(LOC_B))).toBe(false)
  })
  it('a head coach may (MANAGER_ROLES); plain staff may not', () => {
    expect(canCreateEventType(person({ [LOC_A]: { role: 'head_coach' } }, LOC_A))).toBe(true)
    expect(canCreateEventType(person({ [LOC_A]: { role: 'staff' } }, LOC_A))).toBe(false)
  })
  it('a master may, but only with a studio to create in (the route needs location_id)', () => {
    expect(canCreateEventType({ ...MASTER, activeLocation: { id: LOC_A } })).toBe(true)
    expect(canCreateEventType({ ...MASTER, activeLocation: null })).toBe(false)
  })
  it('nobody signed in may not', () => {
    expect(canCreateEventType(null)).toBe(false)
  })
})

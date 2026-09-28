// ROLEUI.1 — the booking-type pages show Edit and Delete exactly when
// /api/bookings/event-types/[id] (PUT, DELETE) would act: a master, or
// MANAGER_ROLES at the booking type's location (ROLESWEEP.2). Same case table
// as tests/role-sweep/api-key-or-manager.test.js runs against the route.
import { describe, it, expect } from 'vitest'
import { canManageEventType } from './event-type-gates'
import { MANAGER_ROLES } from './schemas'
import { roleCases, MASTER, person, LOC_A } from '../../tests/helpers/role-sweep-callers.js'

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

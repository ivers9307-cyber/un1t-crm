// UN1TCOMP.1 — who may add complimentary un1t.online credits: the
// un1t_comp_credits web permission, resolved at the BOOKING studio (the
// card's location) through the full tier order (location switch and bundle,
// master, per-user override, role template, code default). Richard's call:
// on for owner, manager and reception; off for head coach and staff.
import { describe, it, expect } from 'vitest'
import { canGrantCompCredits, UN1T_COMP_CREDITS_PERMISSION } from './un1t-comp-credits-access.js'
import { WEB_PERMISSIONS, DEFAULT_WEB_PERMISSIONS_BY_ROLE } from '@shared/permissions'

const HATCH = 'loc-hatch'
const STILL = 'loc-still'
const userAt = (role, { locId = HATCH, permissions = {}, template = null, features = {}, otherRole = null } = {}) => ({
  id: 'u-1',
  role: otherRole ?? role,
  locations: [{ id: locId, role, features }],
  assignmentsByLocation: { [locId]: { role, permissions } },
  roleTemplatesByLocation: template ? { [locId]: template } : {},
})

describe('the permission key', () => {
  it('is a web permission labelled "Add complimentary credits"', () => {
    expect(UN1T_COMP_CREDITS_PERMISSION).toBe('un1t_comp_credits')
    const entry = WEB_PERMISSIONS.find((p) => p.key === 'un1t_comp_credits')
    expect(entry?.label).toBe('Add complimentary credits')
  })
  it('defaults: owner, manager and reception on; head coach and staff off', () => {
    const d = DEFAULT_WEB_PERMISSIONS_BY_ROLE
    expect([d.owner, d.manager, d.reception].map((r) => r.un1t_comp_credits)).toEqual([true, true, true])
    expect([d.head_coach, d.staff].map((r) => r.un1t_comp_credits)).toEqual([false, false])
  })
})

describe('canGrantCompCredits', () => {
  it('owner, manager and reception at the studio may; head coach and staff may not', () => {
    for (const role of ['owner', 'manager', 'reception']) expect(canGrantCompCredits(userAt(role), HATCH), role).toBe(true)
    for (const role of ['head_coach', 'staff']) expect(canGrantCompCredits(userAt(role), HATCH), role).toBe(false)
  })

  it('is judged at the booking studio: a manager elsewhere who is staff here may not', () => {
    const u = {
      id: 'u-2', role: 'manager',
      locations: [{ id: STILL, role: 'manager' }, { id: HATCH, role: 'staff' }],
      assignmentsByLocation: { [STILL]: { role: 'manager', permissions: {} }, [HATCH]: { role: 'staff', permissions: {} } },
      roleTemplatesByLocation: {},
    }
    expect(canGrantCompCredits(u, STILL)).toBe(true)
    expect(canGrantCompCredits(u, HATCH)).toBe(false)
    expect(canGrantCompCredits(userAt('owner', { locId: STILL }), HATCH)).toBe(false)
  })

  it('a role template at the studio is honoured both ways', () => {
    expect(canGrantCompCredits(userAt('reception', { template: { un1t_comp_credits: false } }), HATCH)).toBe(false)
    expect(canGrantCompCredits(userAt('head_coach', { template: { un1t_comp_credits: true } }), HATCH)).toBe(true)
  })

  it('a per-user override beats the template', () => {
    expect(canGrantCompCredits(userAt('staff', { permissions: { un1t_comp_credits: true }, template: { un1t_comp_credits: false } }), HATCH)).toBe(true)
    expect(canGrantCompCredits(userAt('owner', { permissions: { un1t_comp_credits: false } }), HATCH)).toBe(false)
  })

  it('master may anywhere the studio switch allows; the studio switch denies everyone', () => {
    const master = { id: 'm', role: 'master', locations: [{ id: HATCH, features: {} }], assignmentsByLocation: {}, roleTemplatesByLocation: {} }
    expect(canGrantCompCredits(master, HATCH)).toBe(true)
    const off = { ...master, locations: [{ id: HATCH, features: { un1t_comp_credits: false } }] }
    expect(canGrantCompCredits(off, HATCH)).toBe(false)
    expect(canGrantCompCredits(userAt('owner', { features: { un1t_comp_credits: false } }), HATCH)).toBe(false)
  })

  it('nobody, and no studio, is no', () => {
    expect(canGrantCompCredits(null, HATCH)).toBe(false)
    expect(canGrantCompCredits(userAt('owner'), null)).toBe(false)
  })
})

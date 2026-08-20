// HUBDOOR.1 — the hub index chains as a policy contract.
//
// nav-items.test.js owns the cross-check that every sidebar union key
// reaches one of these chains. This file owns the chains themselves: their
// order (which must mirror each hub's tab strip), their fallbacks, and the
// resolver's first-match-wins behaviour — including the two personas whose
// doors opened onto nothing before this branch.

import { describe, it, expect } from 'vitest'
import { HUB_INDEX_CHAINS, resolveHubIndexTarget } from './hub-index-chains'
import { MANAGER_ROLES } from './schemas'

// A tiny stand-in for hasPermission: the user IS their key set, plus the
// active-location role the role floors read. HUBDOOR.2 added the role
// dimension; 'manager' is the default because it clears every floor the
// chains declare, so every pre-existing case reads unchanged.
const holder = (...keys) => {
  const keySet = new Set(keys)
  return { role: 'manager', has: (k) => keySet.has(k) }
}
const asRole = (role, ...keys) => ({ ...holder(...keys), role })
const can = (user, key) => user.has(key)
const target = (hub, ...keys) => resolveHubIndexTarget(holder(...keys), hub, can)
const targetAs = (role, hub, ...keys) => resolveHubIndexTarget(asRole(role, ...keys), hub, can)

describe('HUB_INDEX_CHAINS shape', () => {
  it('covers exactly the six collapsed hubs', () => {
    expect(Object.keys(HUB_INDEX_CHAINS).sort()).toEqual([
      '/marketing', '/members', '/money', '/operations', '/sales', '/team',
    ])
  })

  it('gives every step a non-empty key list and an absolute target', () => {
    for (const [hub, { chain, fallback }] of Object.entries(HUB_INDEX_CHAINS)) {
      expect(chain.length, `${hub} has an empty chain`).toBeGreaterThan(0)
      for (const step of chain) {
        expect(step.keys.length, `${hub} → ${step.target}`).toBeGreaterThan(0)
        expect(step.target.startsWith('/'), `${hub} → ${step.target}`).toBe(true)
      }
      expect(fallback.startsWith('/')).toBe(true)
    }
  })

  it('never lists the same key twice within one hub (an unreachable second branch)', () => {
    for (const [hub, { chain }] of Object.entries(HUB_INDEX_CHAINS)) {
      const keys = chain.flatMap((s) => s.keys)
      expect(new Set(keys).size, `${hub} repeats a key across steps`).toBe(keys.length)
    }
  })
})

describe('chain order mirrors each hub tab strip', () => {
  const order = (hub) => HUB_INDEX_CHAINS[hub].chain.map((s) => s.target)

  it('Sales: Pipeline, Contacts, Tasks', () => {
    expect(order('/sales')).toEqual(['/pipeline', '/contacts', '/activities'])
  })

  it('Members: Bookings, Events, Challenges, Pulse, Live, Timer, Hyrox', () => {
    expect(order('/members')).toEqual([
      '/bookings', '/events', '/challenges', '/pulse', '/live',
      '/studio-management/timer', '/hyrox',
    ])
  })

  it('Money: the five in-hub tabs, then the two (team) reviewer doors last', () => {
    expect(order('/money')).toEqual([
      '/accounting', '/invoices', '/card-receipts', '/orders', '/offer-sales',
      '/schedule/invoices', '/schedule/expenses',
    ])
  })

  it('Marketing: Automations, Landing page, Send', () => {
    expect(order('/marketing')).toEqual(['/automations', '/settings/landing-page', '/communications/send'])
  })

  it('Operations: Maintenance, Studio, TV, Presentations, Fleet last', () => {
    expect(order('/operations')).toEqual([
      '/maintenance', '/studio-management', '/tv-displays', '/presentations', '/admin/fleet',
    ])
  })

  it('Team: Schedule, Contracts — Policies is the fallback, not a step', () => {
    expect(order('/team')).toEqual(['/schedule', '/contracts'])
    expect(HUB_INDEX_CHAINS['/team'].fallback).toBe('/policies')
  })
})

describe('resolveHubIndexTarget — first match wins, in tab order', () => {
  it('takes the earliest step the user can satisfy', () => {
    expect(target('/sales', 'pipeline', 'contacts')).toBe('/pipeline')
    expect(target('/sales', 'contacts', 'activities')).toBe('/contacts')
  })

  it('falls back when the user holds none of the chain keys', () => {
    expect(target('/sales')).toBe('/')
    expect(target('/operations')).toBe('/')
  })

  it('Team never dead-ends at / — Policies is login-only', () => {
    expect(target('/team')).toBe('/policies')
  })

  it('throws on an unknown hub rather than returning a silent undefined', () => {
    expect(() => resolveHubIndexTarget(holder(), '/nope', can)).toThrow(/unknown hub/)
  })
})

// HUBDOOR.2 — the review finding on HUBDOOR.1. Two targets gate on a role
// floor as well as a key, and a step carrying only the key would redirect
// a below-floor holder into a page that bounces them back out: the exact
// defect this module exists to prevent, committed by the module itself.
describe('role floors — a key below the destination role floor is not a door', () => {
  it('declares a floor on exactly the two role-gated targets, and it is MANAGER_ROLES', () => {
    const floors = Object.entries(HUB_INDEX_CHAINS).flatMap(([hub, { chain }]) =>
      chain.filter((s) => s.roles).map((s) => [hub, s.target, [...s.roles]]),
    )
    expect(floors).toEqual([
      ['/members', '/challenges', [...MANAGER_ROLES]],
      ['/money', '/orders', [...MANAGER_ROLES]],
    ])
  })

  it('Members: a manager holding challenges lands on Challenges', () => {
    expect(targetAs('manager', '/members', 'challenges')).toBe('/challenges')
    expect(targetAs('head_coach', '/members', 'challenges')).toBe('/challenges')
  })

  it('Members: a STAFF holder of challenges falls through, never into the bounce', () => {
    expect(targetAs('staff', '/members', 'challenges')).toBe('/')
    expect(targetAs('reception', '/members', 'challenges')).toBe('/')
  })

  it('Members: falling through means the NEXT step still wins, not the fallback', () => {
    expect(targetAs('staff', '/members', 'challenges', 'pulse_admin')).toBe('/pulse')
    // …and a manager still takes Challenges first, in tab order.
    expect(targetAs('manager', '/members', 'challenges', 'pulse_admin')).toBe('/challenges')
  })

  it('Money: same shape on /orders, which has carried the floor since HUBS.2c', () => {
    expect(targetAs('manager', '/money', 'orders')).toBe('/orders')
    expect(targetAs('staff', '/money', 'orders')).toBe('/')
    expect(targetAs('staff', '/money', 'orders', 'card_receipts')).toBe('/card-receipts')
  })

  it('a master whose ACTIVE-LOCATION role is staff is refused, exactly as both pages refuse them', () => {
    // user.role is resolveActiveLocationRole's answer, and that is the
    // field /orders and /api/challenges both read. Being more generous
    // here would put them on a page that redirects them straight out.
    expect(targetAs('staff', '/members', 'challenges')).toBe('/')
    expect(targetAs('master', '/members', 'challenges')).toBe('/challenges')
  })

  it('a floorless step is unaffected by role', () => {
    for (const role of ['staff', 'reception', 'head_coach', 'manager', 'owner', 'master']) {
      expect(targetAs(role, '/operations', 'fleet_restart')).toBe('/admin/fleet')
      expect(targetAs(role, '/marketing', 'sms')).toBe('/communications/send')
    }
  })
})

// The two defects this branch closes. Each of these assertions FAILS
// against the pre-HUBDOOR.1 chains, where the key was in the sidebar
// union but in no branch of the index, so the persona landed on '/'.
describe('defect A — the sms-only Marketing door', () => {
  it('an sms-only holder lands on Send, not the / bounce', () => {
    expect(target('/marketing', 'sms')).toBe('/communications/send')
  })

  it('sms does not jump the queue: an automations holder still lands on Automations', () => {
    expect(target('/marketing', 'sms', 'automations')).toBe('/automations')
  })

  it('sms sits after landing_page, matching the tab strip', () => {
    expect(target('/marketing', 'sms', 'landing_page')).toBe('/settings/landing-page')
  })

  it('the Automations step still matches that page own gate exactly', () => {
    for (const k of ['automations', 'email', 'whatsapp', 'device_control']) {
      expect(target('/marketing', k)).toBe('/automations')
    }
  })
})

describe('defect B — the fleet-only Operations door', () => {
  it('a fleet_restart-only holder lands on the fleet page, not the / bounce', () => {
    expect(target('/operations', 'fleet_restart')).toBe('/admin/fleet')
  })

  it('a fleet_admin-only holder lands there too', () => {
    expect(target('/operations', 'fleet_admin')).toBe('/admin/fleet')
  })

  // equipment_inspect defaults ON for every role, so in practice reaching
  // the fleet-only state takes deliberate revocation — and any of the five
  // in-hub tabs still wins over Fleet, which is last in the strip.
  it('fleet is last: any in-hub Operations tab still wins', () => {
    expect(target('/operations', 'fleet_admin', 'presentations')).toBe('/presentations')
    expect(target('/operations', 'fleet_admin', 'equipment_inspect')).toBe('/maintenance')
  })
})

describe('visibilityOnly — union keys that deliberately reach no surface', () => {
  it('is empty for every hub except Members', () => {
    const declared = Object.entries(HUB_INDEX_CHAINS)
      .filter(([, h]) => h.visibilityOnly.length > 0)
      .map(([hub, h]) => [hub, [...h.visibilityOnly]])
    expect(declared).toEqual([['/members', ['events']]])
  })

  it('a visibilityOnly key is never also a chain key (that would be a contradiction)', () => {
    for (const [hub, { chain, visibilityOnly }] of Object.entries(HUB_INDEX_CHAINS)) {
      const chainKeys = new Set(chain.flatMap((s) => s.keys))
      for (const k of visibilityOnly) {
        expect(chainKeys.has(k), `${hub}: "${k}" is both visibilityOnly and a chain key`).toBe(false)
      }
    }
  })
})

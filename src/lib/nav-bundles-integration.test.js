// R2 (final-review rider) — integration test pinning the dual-owned
// bundle case END TO END, driving the REAL canonical resolver
// (resolvePermission from shared/permissions.js) against the REAL
// sidebar nav union arrays (ALL_NAV from src/lib/nav-items.js), not a
// hand-rolled stand-in for either. permission-bundles.test.js already
// unit-tests bundlesDenyKey/KEY_BUNDLES directly (fast, isolated);
// this file exists to catch drift BETWEEN nav-items.js's anyPermission
// unions and shared/permission-bundles.js's KEY_BUNDLES map, which
// neither suite alone can see.
//
// Case pinned: `studio_management` is listed in BOTH the Members hub's
// and the Operations hub's anyPermission union (nav-items.js), and
// KEY_BUNDLES owns it from both bundle_members AND bundle_operations
// (OR semantics — see permission-bundles.js). Turning off only one of
// the two owning bundles must NOT deny it; turning off both must.

import { describe, it, expect } from 'vitest'
import { resolvePermission, DEFAULT_WEB_PERMISSIONS_BY_ROLE } from '@shared/permissions'
import { KEY_BUNDLES } from '@shared/permission-bundles'
import { ALL_NAV } from './nav-items'

// master bypasses tiers 2/2.5/3 once tier 1 (location gate) passes, so
// it isolates the bundle-layer behaviour cleanly — no role-default /
// per-user-permission noise.
function resolvesAtLocation(features, key) {
  return resolvePermission({
    role: 'master',
    location: { features },
    permissions: null,
    roleTemplate: null,
    defaults: {},
    key,
  })
}

const membersEntry = ALL_NAV.find((i) => i.href === '/members')
const operationsEntry = ALL_NAV.find((i) => i.href === '/operations')

describe('R2 — real resolver × real nav unions: the studio_management dual-owner case', () => {
  it('sanity: both hub entries exist and both real anyPermission unions list studio_management', () => {
    expect(membersEntry).toBeTruthy()
    expect(operationsEntry).toBeTruthy()
    expect(membersEntry.anyPermission).toContain('studio_management')
    expect(operationsEntry.anyPermission).toContain('studio_management')
  })

  it('sanity: KEY_BUNDLES really owns studio_management from both bundle_members and bundle_operations', () => {
    expect(KEY_BUNDLES.studio_management.slice().sort()).toEqual(['bundle_members', 'bundle_operations'])
  })

  it('location {bundle_members: false} — studio_management still resolves true (operations co-owns it)', () => {
    expect(resolvesAtLocation({ bundle_members: false }, 'studio_management')).toBe(true)
  })

  it('location {bundle_members: false} — every PURE bundle_members-only key in the Members union resolves false', () => {
    const pureMembersKeys = membersEntry.anyPermission.filter((key) => {
      const owners = KEY_BUNDLES[key]
      return Array.isArray(owners) && owners.length === 1 && owners[0] === 'bundle_members'
    })
    // Sanity the filter actually matched something real (bookings,
    // events, races, challenges, pulse_admin, class_timer) — an empty
    // list would make the assertion below vacuously true.
    expect(pureMembersKeys.length).toBeGreaterThan(0)
    for (const key of pureMembersKeys) {
      expect(resolvesAtLocation({ bundle_members: false }, key)).toBe(false)
    }
  })

  it('location {bundle_members: false, bundle_operations: false} — studio_management now resolves false (both owners off)', () => {
    expect(resolvesAtLocation({ bundle_members: false, bundle_operations: false }, 'studio_management')).toBe(false)
  })
})

// Final-review fix 1 persona test — the "Money chrome leak" this fix
// closes. Drives the REAL resolver (via a realistic 'owner' role, not
// master — so tier 3 role defaults are actually exercised) against the
// REAL Money hub anyPermission union. Before the fix, 3 of these 7 keys
// (the approvals_* trio) were fully exempt from the bundle layer, so
// the union stayed non-empty — Money's sidebar entry, redirect chain,
// (money) review tabs and /offer-sales all stayed reachable — even at
// bundle_money: false, for any role (owner by role default) holding
// those three grants.
const moneyEntry = ALL_NAV.find((i) => i.href === '/money')

function resolvesForOwner(features, key) {
  return resolvePermission({
    role: 'owner',
    location: { features },
    permissions: null,
    roleTemplate: null,
    defaults: DEFAULT_WEB_PERMISSIONS_BY_ROLE,
    key,
  })
}

describe('final-review fix 1 — bundle_money:false closes Money chrome entirely for an owner', () => {
  it('sanity: the real Money anyPermission union is the expected 7 keys, incl. the 3 approvals_* keys', () => {
    expect(moneyEntry).toBeTruthy()
    expect(moneyEntry.anyPermission).toEqual([
      'accounting_hub', 'invoices_inbox', 'card_receipts', 'orders',
      'approvals_offer_purchases', 'approvals_contractor_invoices', 'approvals_fte_expenses',
    ])
  })

  it('sanity: an owner holds every one of those 7 keys by role default at an unconstrained ({}) location', () => {
    for (const key of moneyEntry.anyPermission) {
      expect(resolvesForOwner({}, key), key).toBe(true)
    }
  })

  it('bundle_money: false denies EVERY key in the real Money union for an owner — the union goes fully empty, the hub entry disappears', () => {
    for (const key of moneyEntry.anyPermission) {
      expect(resolvesForOwner({ bundle_money: false }, key), key).toBe(false)
    }
    // What nav-items.js's own anyPermission check actually ORs —
    // proves the WHOLE hub entry, not just individual keys, goes dark.
    const hubVisible = moneyEntry.anyPermission.some((key) => resolvesForOwner({ bundle_money: false }, key))
    expect(hubVisible).toBe(false)
  })

  it('bundle_money: true (or any other bundle off) leaves the union intact', () => {
    const hubVisible = moneyEntry.anyPermission.some((key) => resolvesForOwner({ bundle_money: true, bundle_sales: false }, key))
    expect(hubVisible).toBe(true)
  })
})

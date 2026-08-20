// HUBS.2c — /money hub index. The sidebar's single Money entry points
// here; the hub's real surfaces keep their existing URLs (/accounting,
// /invoices, /card-receipts, /orders, /offer-sales). This page just
// redirects to the first tab the signed-in user's permissions allow, in
// that priority order. Gate keys mirror each PAGE's own gate
// (accounting page checks `accounting_hub`, invoices checks
// `invoices_inbox`, etc.), not the old nav entries' looser gates.
//
// Mirrors src/app/members/page.test.js (HUBS.2b) exactly: hoisted
// vi.mock for @/lib/auth + next/navigation (redirect throws
// NEXT_REDIRECT:<url>, matching production behaviour). Permissions are
// NOT mocked — the fixture drives the real resolver (hasPermission →
// shared/permissions.js resolvePermission) via
// activeAssignment.permissions overrides, the same fixture shape used
// by src/lib/dashboard-redirect.test.js's `user()` factory (role +
// activeLocation + activeAssignment.permissions). Every fixture below
// sets all five gate keys EXPLICITLY — role defaults for staff grant
// many of them, so an omitted key would pass for the wrong reason.
//
// approvals_offer_purchases is one of the APPROVAL_SUBPERMISSION_KEYS
// (shared/permissions.js) — per-category approval grants are pure
// grants, not location features, so isFeatureGatedByLocation() exempts
// it. accounting_hub, invoices_inbox, card_receipts and orders are NOT
// exempt (not notify keys, not approval sub-permissions) so they ARE
// location-gated — confirmed by reading isFeatureGatedByLocation()
// directly rather than assumed.
//
// DEEP.4 Task 1 (4A) — approvals_contractor_invoices and
// approvals_fte_expenses join the chain AFTER approvals_offer_purchases,
// LAST, mirroring (money)/layout.js's tab order (contractor invoices and
// expenses are the final two tabs). Both are also
// APPROVAL_SUBPERMISSION_KEYS (same family as approvals_offer_purchases)
// so they're exempt from the location gate too — an approver reaches the
// review queue regardless of the location's feature flags.
//
// DEEP.4 final review — originally placed BEFORE approvals_offer_purchases;
// moved after it so an offers+contractor approver lands in-hub at
// /offer-sales rather than bouncing to /schedule/invoices (Team chrome).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

import MoneyIndexPage from './page.js'
import { getCurrentUser } from '@/lib/auth'

// Stable user fixture — explicit per-user permission overrides
// (tier 2 of the resolver) so each test controls exactly which of the
// five gate keys the fixture holds, regardless of role defaults.
// ALL five keys are always passed explicitly.
function user({ role = 'staff', perms = {} } = {}) {
  const allDenied = {
    accounting_hub: false,
    invoices_inbox: false,
    card_receipts: false,
    orders: false,
    approvals_contractor_invoices: false,
    approvals_fte_expenses: false,
    approvals_offer_purchases: false,
  }
  return {
    id: 'u1',
    role,
    activeLocation: { id: 'loc1', features: {} },
    activeAssignment: { permissions: { ...allDenied, ...perms } },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('/money index page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  it('redirects to /accounting when all seven keys are granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          accounting_hub: true,
          invoices_inbox: true,
          card_receipts: true,
          orders: true,
          approvals_contractor_invoices: true,
          approvals_fte_expenses: true,
          approvals_offer_purchases: true,
        },
      })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/accounting')
  })

  it('redirects to /invoices when accounting_hub is denied but the rest are granted', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          accounting_hub: false,
          invoices_inbox: true,
          card_receipts: true,
          orders: true,
          approvals_contractor_invoices: true,
          approvals_fte_expenses: true,
          approvals_offer_purchases: true,
        },
      })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/invoices')
  })

  it('redirects to /card-receipts when only card_receipts is held', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { card_receipts: true } }))
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/card-receipts')
  })

  // HUBDOOR.2 — /orders has ALWAYS gated on MANAGER_ROLES as well as the
  // key; the chain now honours that floor instead of merely noting it, so
  // the step can no longer redirect a staff-role `orders` holder into a
  // page that redirects them straight back out. This case previously
  // asserted that bounce (the fixture role defaults to 'staff').
  it('redirects to /orders when only orders is held, at a role that clears the floor', async () => {
    getCurrentUser.mockResolvedValue(user({ role: 'manager', perms: { orders: true } }))
    await expect(MoneyIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/orders$/)
  })

  it('does NOT send a staff or reception holder of orders into that bounce', async () => {
    for (const role of ['staff', 'reception']) {
      getCurrentUser.mockResolvedValue(user({ role, perms: { orders: true } }))
      await expect(MoneyIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
    }
  })

  it('a below-floor orders holder still takes the NEXT step they can open', async () => {
    getCurrentUser.mockResolvedValue(
      user({ role: 'staff', perms: { orders: true, approvals_offer_purchases: true } })
    )
    await expect(MoneyIndexPage()).rejects.toThrow(/^NEXT_REDIRECT:\/offer-sales$/)
  })

  // DEEP.4 final review — the two approver keys sit AFTER
  // approvals_offer_purchases, last in the chain, mirroring the tab order
  // in (money)/layout.js.
  it('redirects to /schedule/invoices when only approvals_contractor_invoices is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { approvals_contractor_invoices: true } })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/schedule/invoices')
  })

  it('redirects to /schedule/expenses when only approvals_fte_expenses is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { approvals_fte_expenses: true } })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/schedule/expenses')
  })

  it('redirects to /schedule/invoices ahead of /schedule/expenses when both approver keys are held but not approvals_offer_purchases (chain order)', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          approvals_contractor_invoices: true,
          approvals_fte_expenses: true,
        },
      })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/schedule/invoices')
  })

  it('redirects to /offer-sales when only approvals_offer_purchases is held', async () => {
    getCurrentUser.mockResolvedValue(
      user({ perms: { approvals_offer_purchases: true } })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/offer-sales')
  })

  // DEEP.4 final review — offers now precedes both approver keys in the
  // chain, so an offers+contractor+expenses approver lands IN-hub at
  // /offer-sales rather than bouncing to Team chrome at /schedule/invoices.
  it('redirects to /offer-sales ahead of /schedule/invoices and /schedule/expenses when all three approver keys are held (chain order)', async () => {
    getCurrentUser.mockResolvedValue(
      user({
        perms: {
          approvals_contractor_invoices: true,
          approvals_fte_expenses: true,
          approvals_offer_purchases: true,
        },
      })
    )
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/offer-sales')
  })

  it('redirects to / when none of the seven are held', async () => {
    getCurrentUser.mockResolvedValue(user())
    await expect(MoneyIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })

  it('redirects to /invoices when the location gate denies accounting_hub for everyone, even with accounting_hub permission held', async () => {
    const u = user({
      perms: {
        accounting_hub: true,
        invoices_inbox: true,
        card_receipts: true,
        orders: true,
        approvals_contractor_invoices: true,
        approvals_fte_expenses: true,
        approvals_offer_purchases: true,
      },
    })
    u.activeLocation = { id: 'loc1', features: { accounting_hub: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/invoices')
  })

  it('redirects to /schedule/invoices when the location gate denies orders for everyone, even with orders permission held (approvals_contractor_invoices is exempt from location gating)', async () => {
    const u = user({
      perms: {
        orders: true,
        approvals_contractor_invoices: true,
      },
    })
    u.activeLocation = { id: 'loc1', features: { orders: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(MoneyIndexPage()).rejects.toThrow('NEXT_REDIRECT:/schedule/invoices')
  })

  // BUNDLES.5 final-review fix 1 — the "Money chrome leak". Before this
  // fix, approvals_contractor_invoices/approvals_fte_expenses/
  // approvals_offer_purchases were fully exempt from the bundle layer
  // (not just from their own per-key toggle), so this exact fixture —
  // every one of the seven gate keys granted — still landed in-hub at
  // /accounting even at bundle_money: false. Now bundle_money: false
  // denies all seven (the three approvals_* keys via their category,
  // shared/permissions.js APPROVAL_CATEGORY_PERMISSION → bundle_money),
  // so Money has nowhere left to redirect to.
  it('redirects to / when bundle_money is explicitly false, even with all seven Money gate keys granted', async () => {
    const u = user({
      perms: {
        accounting_hub: true,
        invoices_inbox: true,
        card_receipts: true,
        orders: true,
        approvals_contractor_invoices: true,
        approvals_fte_expenses: true,
        approvals_offer_purchases: true,
      },
    })
    u.activeLocation = { id: 'loc1', features: { bundle_money: false } }
    getCurrentUser.mockResolvedValue(u)
    await expect(MoneyIndexPage()).rejects.toThrow(/NEXT_REDIRECT:\/$/)
  })
})

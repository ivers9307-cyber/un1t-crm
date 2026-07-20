// REPSET-ACCOUNT.2 — the account-tier navigation contract.
//
// The Repset platform has three tiers: Platform (master, cross-tenant)
// / Account (a gym company = an `organization`) / Studio (a `location`).
// At the ACCOUNT tier the studio operational menu (Communications,
// Bookings, Approvals, Accounting, Pipeline, Contacts, …) is the wrong
// altitude — it's a single studio's CRM. This module owns WHAT the
// account-level nav contains so it's a tested policy contract (see
// account-nav.test.js), the same split nav-items.js uses for the
// studio sidebar. AccountShell.jsx owns rendering; this owns the model.
//
// Audience is owner-of-active-org / master (the /portfolio guard). Every
// item here is already safe for that audience, so there is no per-item
// permission gate — the tier gate is the gate.

import { Building2, CreditCard, Cable, UsersRound } from 'lucide-react'

// Which paths render the ACCOUNT shell instead of the studio sidebar.
// AppShell imports this so the shell swap and the nav model agree on
// what "the account tier" is. Matched exact-or-prefixed (p + '/').
export const ACCOUNT_TIER_PATHS = Object.freeze(['/portfolio'])

/**
 * Is this pathname an account-tier surface (gets the account shell)?
 * Exact match or a nested segment (`/portfolio/...`). Pure.
 *
 * @param {string|null|undefined} pathname
 * @returns {boolean}
 */
export function isAccountTierPath(pathname) {
  if (!pathname) return false
  return ACCOUNT_TIER_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

// The account-home overview link.
export const ACCOUNT_OVERVIEW = Object.freeze({ href: '/portfolio', label: 'Overview', icon: Building2 })

// Secondary "Manage" items. `live: false` renders a disabled "Soon"
// row (kept visible so the shape of the account tier is legible) —
// see resolveAccountNav for the live/deferred rationale.
//   - Billing & usage → /settings/billing (INTEG-D1) — owner/master,
//     org-oriented. LIVE.
//   - Integrations    → /settings/integrations-hub (INTEG-B4) — owner+
//     is HARD-SCOPED to their own org's locations there, so it genuinely
//     fits an owner at the account tier. LIVE.
//   - Team & roles    → DEFERRED. The only existing surface
//     (/settings/staff) is a per-studio Settings roster gated on the
//     `settings` permission, not an account-level team/roles manager;
//     rather than drop an account-tier owner into a studio settings
//     page, this is a "Soon" placeholder until an org-level surface
//     exists. (No new page is built in this phase — shell + wiring only.)
export const ACCOUNT_MANAGE_ITEMS = Object.freeze([
  Object.freeze({ key: 'billing', href: '/settings/billing', label: 'Billing & usage', icon: CreditCard, live: true }),
  Object.freeze({ key: 'integrations', href: '/settings/integrations-hub', label: 'Integrations', icon: Cable, live: true }),
  Object.freeze({ key: 'team', href: null, label: 'Team & roles', icon: UsersRound, live: false }),
])

/**
 * Resolve the account-tier nav for a user. Pure — no DB, no clock.
 *
 * The Studios list is the caller's accessible studios in their ACTIVE
 * org (`user.locations` filtered by `activeOrganization.id`). That is
 * exactly the set the shared set-active-location path can validly
 * target: getCurrentUser() ignores an active-location cookie that
 * points at a studio the caller has no assignment to, so listing only
 * `user.locations` keeps the "you can only open a studio you already
 * have access to" guarantee (a master's `user.locations` is every
 * active location, so they still see the whole org).
 *
 * @param {object|null} user  getCurrentUser() result
 * @returns {{
 *   overview: {href:string,label:string,icon:Function},
 *   studios: Array<{id:string,name:string,isActive:boolean}>,
 *   manage: typeof ACCOUNT_MANAGE_ITEMS,
 *   enterStudioId: string|null,
 * }}
 */
export function resolveAccountNav(user) {
  const activeOrgId = user?.activeOrganization?.id || null
  const activeLocationId = user?.activeLocation?.id || null

  const studios = (Array.isArray(user?.locations) ? user.locations : [])
    .filter((l) => l && l.id && (!activeOrgId || l.organization_id === activeOrgId))
    .map((l) => ({ id: l.id, name: l.name || 'Studio', isActive: l.id === activeLocationId }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // "Enter studio →": prefer the current active studio if it's in this
  // org's list, else the first studio, else nothing (no studio to open).
  const activeInOrg = studios.some((s) => s.id === activeLocationId)
  const enterStudioId = activeInOrg ? activeLocationId : (studios[0]?.id || null)

  return {
    overview: ACCOUNT_OVERVIEW,
    studios,
    manage: ACCOUNT_MANAGE_ITEMS,
    enterStudioId,
  }
}

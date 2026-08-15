// REPSET-PLATFORM.1 — the PLATFORM-tier (master console) navigation contract.
//
// The Repset platform has three tiers: Platform (master, cross-tenant)
// / Account (a gym company = an `organization`) / Studio (a `location`).
// Phase 1 (REPSET-ACCOUNT.*) shipped the Account tier. This module owns
// the PLATFORM tier — the master's cross-tenant cockpit. At this tier
// the studio operational menu (Communications, Bookings, Approvals, …)
// and the account org menu are both the wrong altitude: this is the
// platform operator's view over EVERY tenant.
//
// Richard's /admin decision (Phase 2): gather the clearly-platform pages
// under the console — originally just `tenants`, `plans`,
// `tenant-domains`, `health`. ADMIN.2h Task 2 grew that to eight: the
// ADMIN.2h dissolution review found FIVE /admin pages with no persistent
// nav entry anywhere (the soon-to-die /admin index was their only
// bridge) — `matrix`, `bridges`, `studio-devices`, `webhook-dead-letter`
// and `fleet`. Four of those five are master-only-or-owner platform
// tools, so they join the console here. `fleet` is the odd one out —
// it's reachable by non-owner staff (fleet_restart), so it gets a home
// via an Operations hub tab instead (see (operations)/layout.js) and
// deliberately stays OUT of this contract; /admin/fleet keeps rendering
// the normal studio shell for everyone, master included. Mirrors
// account-nav.js: PlatformShell.jsx owns rendering, this owns the model
// (tested in platform-nav.test.js).
//
// Audience is master-only for the console SHELL. The eight pages already
// enforce their own page-level gates (unchanged) — some master-only,
// webhook-dead-letter master-or-owner. This module is presentation, and
// AppShell only engages the platform branch for `user.isMaster`.
//
// webhook-dead-letter's owner access is preserved BY THE PREDICATE
// DESIGN, not by any owner carve-out here: AppShell's platform branch
// requires `user.isMaster && isPlatformTierPath(pathname)`, so an owner
// (non-master) landing on /admin/webhook-dead-letter falls straight
// through to the normal studio shell, and the page's own master-or-owner
// gate admits them there. Chrome differs by role (console vs. studio
// sidebar); actual access does not.

import {
  Building2, Tag, Globe, Activity, UserPlus, ScrollText,
  LayoutGrid, Radio, Smartphone, AlertTriangle,
} from 'lucide-react'

// Which route roots render the PLATFORM console shell instead of the
// studio sidebar. AppShell imports this so the shell swap and the nav
// model agree on what "the console" is. Matched exact-or-prefixed
// (p + '/'), so a nested page like /admin/tenants/new or
// /admin/tenants/<orgId> stays inside the console shell too. Exactly
// these eight — every other /admin/* page (including /admin/fleet —
// see the header comment) keeps its current (studio) shell.
export const PLATFORM_TIER_PATHS = Object.freeze([
  '/admin/tenants',
  '/admin/plans',
  '/admin/tenant-domains',
  '/admin/health',
  '/admin/matrix',
  '/admin/bridges',
  '/admin/studio-devices',
  '/admin/webhook-dead-letter',
])

/**
 * Is this pathname a platform-tier surface (gets the console shell)?
 * Exact match or a nested segment (`/admin/tenants/...`). Pure.
 *
 * NOTE: this is a PATH predicate only — it does NOT check the master
 * role. AppShell gates the console branch on `user.isMaster` as well,
 * so a non-master who reaches a console path still gets the normal
 * shell (and the page's own master guard then redirects them). Keeping
 * the role check out of here mirrors isAccountTierPath (pure path test)
 * and keeps this unit-testable without a user fixture.
 *
 * @param {string|null|undefined} pathname
 * @returns {boolean}
 */
export function isPlatformTierPath(pathname) {
  if (!pathname) return false
  return PLATFORM_TIER_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

// The eight console pages, in nav order. Tenants is the home (the master
// landing target). All eight routes exist in-repo; each enforces its own
// page-level gate (matrix/bridges/studio-devices are master-only,
// webhook-dead-letter is master-or-owner — see the header comment), so
// every one is live for the console's actual audience (masters).
export const PLATFORM_PRIMARY_ITEMS = Object.freeze([
  Object.freeze({ key: 'tenants', href: '/admin/tenants', label: 'Tenants', icon: Building2 }),
  Object.freeze({ key: 'plans', href: '/admin/plans', label: 'Plans & pricing', icon: Tag }),
  Object.freeze({ key: 'domains', href: '/admin/tenant-domains', label: 'Domains', icon: Globe }),
  Object.freeze({ key: 'health', href: '/admin/health', label: 'Platform health', icon: Activity }),
  // ADMIN.2h Task 2 additions — the four orphaned platform pages.
  Object.freeze({ key: 'matrix', href: '/admin/matrix', label: 'Feature matrix', icon: LayoutGrid }),
  Object.freeze({ key: 'bridges', href: '/admin/bridges', label: 'HR bridges', icon: Radio }),
  Object.freeze({ key: 'studio-devices', href: '/admin/studio-devices', label: 'Studio devices', icon: Smartphone }),
  Object.freeze({ key: 'webhook-dead-letter', href: '/admin/webhook-dead-letter', label: 'Dead letters', icon: AlertTriangle }),
])

// Secondary "Actions" items — cross-links a master reaches from the
// console. Each candidate carries `live` = whether its route exists in
// this repo; resolvePlatformNav filters to the live ones (an absent
// page is OMITTED, not shown as a dead row — these are real links, not
// "Soon" placeholders).
//   - Provision tenant → /admin/tenants/new (SAAS4-P2 wizard). It is
//     NESTED under /admin/tenants, so it stays inside the console shell.
//   - Audit log → /settings/audit-log (AUDIT-EXPAND.1, master-only;
//     ADMIN.2h Task 1 moved it out of /admin). It is NOT one of the
//     eight console roots, so it keeps its current (studio) shell —
//     this is an intentional cross-link OUT of the console to the
//     platform-wide audit trail.
const PLATFORM_ACTION_CANDIDATES = Object.freeze([
  Object.freeze({ key: 'provision', href: '/admin/tenants/new', label: 'Provision tenant', icon: UserPlus, live: true, insideShell: true }),
  Object.freeze({ key: 'audit', href: '/settings/audit-log', label: 'Audit log', icon: ScrollText, live: true, insideShell: false }),
])

// Where "Exit to app →" lands: the normal studio/account experience.
// /dashboard is the operational app (studio shell) and is NOT a
// platform-tier path and NOT `/`, so it can never bounce back into the
// console (loop-safe — the master-landing redirect only fires at `/`).
export const PLATFORM_EXIT_ROUTE = '/dashboard'

// Brand shown in the console shell header. "Repset · Platform" reads as
// the platform-operator cockpit (kept clean; the org/app name is the
// account tier's job).
export const PLATFORM_BRAND = Object.freeze({ title: 'Repset', eyebrow: 'Platform' })

/**
 * Resolve the platform-tier (console) nav. Pure — no DB, no clock.
 *
 * The nav is static (the eight console pages + the live cross-links) —
 * unlike the account tier there's no per-user studio list, because the
 * console is deliberately cross-tenant. `user` is accepted for shape
 * parity with resolveAccountNav (and so a future per-master gate can
 * live here), but is not required.
 *
 * @param {object|null} [user]  getCurrentUser() result (unused today)
 * @returns {{
 *   brand: {title:string, eyebrow:string},
 *   primary: typeof PLATFORM_PRIMARY_ITEMS,
 *   actions: Array<{key:string,href:string,label:string,icon:Function,insideShell:boolean}>,
 *   exitHref: string,
 * }}
 */
export function resolvePlatformNav(user) { // eslint-disable-line no-unused-vars
  const actions = PLATFORM_ACTION_CANDIDATES
    .filter((a) => a.live && a.href)
    .map((a) => ({ key: a.key, href: a.href, label: a.label, icon: a.icon, insideShell: a.insideShell }))

  return {
    brand: PLATFORM_BRAND,
    primary: PLATFORM_PRIMARY_ITEMS,
    actions,
    exitHref: PLATFORM_EXIT_ROUTE,
  }
}

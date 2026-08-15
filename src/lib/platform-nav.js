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
// Richard's /admin decision (Phase 2): gather ONLY the four clearly-
// platform pages under the console — `tenants`, `plans`,
// `tenant-domains`, `health` — and leave everything else in /admin
// exactly where it is (reviewed 1-by-1 later). So this contract claims
// only those four route roots; the console shell renders on them and
// nowhere else. Mirrors account-nav.js: PlatformShell.jsx owns
// rendering, this owns the model (tested in platform-nav.test.js).
//
// Audience is master-only. The four pages already enforce their own
// master page-guards (unchanged); this shell is presentation, and
// AppShell only engages the platform branch for `user.isMaster`.

import { Building2, Tag, Globe, Activity, UserPlus, ScrollText } from 'lucide-react'

// Which route roots render the PLATFORM console shell instead of the
// studio sidebar. AppShell imports this so the shell swap and the nav
// model agree on what "the console" is. Matched exact-or-prefixed
// (p + '/'), so a nested page like /admin/tenants/new or
// /admin/tenants/<orgId> stays inside the console shell too. ONLY these
// four — every other /admin/* page keeps its current (studio) shell.
export const PLATFORM_TIER_PATHS = Object.freeze([
  '/admin/tenants',
  '/admin/plans',
  '/admin/tenant-domains',
  '/admin/health',
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

// The four console pages, in nav order. Tenants is the home (the master
// landing target). All four routes exist in-repo and are master-gated,
// so every one is live.
export const PLATFORM_PRIMARY_ITEMS = Object.freeze([
  Object.freeze({ key: 'tenants', href: '/admin/tenants', label: 'Tenants', icon: Building2 }),
  Object.freeze({ key: 'plans', href: '/admin/plans', label: 'Plans & pricing', icon: Tag }),
  Object.freeze({ key: 'domains', href: '/admin/tenant-domains', label: 'Domains', icon: Globe }),
  Object.freeze({ key: 'health', href: '/admin/health', label: 'Platform health', icon: Activity }),
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
//     four console roots, so it keeps its current (studio) shell —
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
 * The nav is static (the four console pages + the live cross-links) —
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

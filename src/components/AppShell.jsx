'use client'

import { usePathname, useRouter } from 'next/navigation'
import { Fragment, useState, useEffect } from 'react'
import Sidebar from './Sidebar'
import AccountShell from './account/AccountShell'
import PlatformShell from './platform/PlatformShell'
import ImpersonationBanner from './ImpersonationBanner'
import SupportBanner from './SupportBanner'
import PendingContractsAlert from './PendingContractsAlert'
import CommandPalette from './CommandPalette'
import AssistantBubble from './AssistantBubble'
import { hasPermission } from '@/lib/permissions'
import { isAccountTierPath } from '@/lib/account-nav'
import { isPlatformTierPath } from '@/lib/platform-nav'
// PERF.3 — Vercel SpeedInsights + Analytics mount in the authenticated
// branch below (NOT the root layout) so /login and the public booking/
// payment surfaces don't pay for the two analytics bundles pre-auth.
// The root layout's PERF.3 comment points here — keep them in sync.
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Analytics } from '@vercel/analytics/next'

// NOTE: '/event-pay' must be listed SEPARATELY from '/event' — the matcher
// is `pathname === p || startsWith(p + '/')`, so '/event' does NOT cover
// '/event-pay/<id>' (the Revolut checkout page reached from "Book & pay").
// Without it, a public buyer with no session gets bounced to /login after
// clicking Pay Now. Mirrors the allowlist in proxy.js. Do not drop on refactor.
// '/stillorgan' + '/hatch-street' are the studio pretty-paths: next.config
// rewrites them to /welcome/<studio>, but the browser URL — and therefore
// usePathname() here — stays the pretty path. Without them a logged-out
// visitor to the public studio page is bounced to /login on hydration (the
// server renders fine; this client gate is what redirects). Mirrors the
// brand allowlist in src/lib/brands.js — add a new studio's path in BOTH.
// '/h' — public host mailing-list signup pages (/h/[slug], HOST-EMAIL.2).
// '/unsubscribe' — the unsubscribe pages (global /unsubscribe/[token] AND the
// per-host /unsubscribe/host/[token]): anonymous email recipients arrive with
// no session, and without this entry the null-user redirect below bounced
// them to /login. Mirrors the proxy.js allowlist — add new paths in BOTH.
// '/preferences' — the preference centre (/preferences/[token]). LOCCOMMS.4
// found this MISSING while the proxy.js allowlist already had '/preferences/',
// so the server rendered the page and this client gate then bounced the visitor
// to /login: every "manage your preferences" link in every marketing email led
// to a login wall. Anonymous recipients have no session by definition. Same
// class as the '/unsubscribe' and '/privacy' entries above — the third
// allowlist is the one that keeps getting missed.
// '/privacy' — public legal pages (/privacy, /privacy/members,
// /privacy/authority-requests) and '/terms' — the Terms of Service. These
// are server-rendered public policy pages (App Store + Meta App Review link
// to them). They were missing here, so a logged-out visitor on the marketing
// host was bounced to /login → which that host rewrites to /welcome, i.e. the
// server-rendered policy flashed then vanished into the studio chooser.
// Mirrors the proxy.js + brands.js allowlists — add new paths in ALL FOUR.
//
// FOUR, not three (PUBPATH.1 corrected the count): (1) src/proxy.js
// publicPaths, (2) this list, (3) the un1t-marketing allowedPaths in
// src/lib/brands.js, and (4) DB_BRAND_DEFAULTS.allowedPaths in
// src/lib/tenant-domains-edge.js — the SAAS-8 tenant-domain tier, which is
// the easiest to miss because it lives in a different file and reads like
// config. docs/CHANGELOG.md's SAAS4-C4 entry already named all four.
//
// '/account-deletion' + '/embed' — PUBPATH.1, the same defect one more time.
// '/account-deletion' is the Play Console "Account Deletion URL" + the Apple
// 5.1.1(v) page, and it was missing from all FOUR lists; '/embed' (the
// paste-anywhere event-signup iframe, /embed/event/[slug]) was in proxy.js
// but not here, so a third-party iframe server-rendered the page and this
// gate then blanked it and redirected the visitor's frame to /login — dead
// for the entire audience the route exists for. Both are anonymous-by-
// definition surfaces: store reviewers and third-party site visitors have no
// session. Note the matcher is segment-aware (`=== p || startsWith(p + '/')`),
// so entries here carry NO trailing slash — '/embed' covers /embed/event/x.
// Regression guard: src/public-compliance-paths.test.jsx.
// AUDIT-13.B — '/race' + '/race-pay' are next.config.js's forever-aliases
// for '/event' + '/event-pay'. A rewrite changes the path the server
// renders, not the URL the browser holds, so usePathname() still reports
// the LEGACY path here and the shell blanked the page it had just
// rendered. Segment-aware matcher, so no trailing slash (see the proxy's
// list, which is raw startsWith and therefore keeps one).
const PUBLIC_PATHS = ['/login', '/auth/callback', '/reset-password', '/welcome', '/stillorgan', '/hatch-street', '/free-class', '/start', '/offers', '/deposit', '/book', '/event', '/event-pay', '/race', '/race-pay', '/class-pay', '/tv', '/present', '/studio-login', '/bca', '/host-connect', '/host', '/h', '/unsubscribe', '/preferences', '/view-email', '/privacy', '/terms', '/legal', '/technical', '/account-deletion', '/embed', '/givers', '/use-the-app']

export default function AppShell({ user, children, isLinkedHost = false }) {
  const pathname = usePathname()
  const router = useRouter()
  // Hooks must run before any early return — keep them at the top so the
  // hook order is stable across the public/protected branches below.
  const [mobileOpen, setMobileOpen] = useState(false)

  // '/' is the marketing site's front door: on un1tdublin.com the proxy
  // rewrites the bare root to /welcome (the split chooser) while the
  // browser URL — and therefore usePathname() — stays '/'. Without this
  // exact-match, the null-user redirect below bounced every logged-out
  // visitor of the bare domain to /login on hydration (latent since
  // d184209; surfaced during the 2026-06 redesign verification). The
  // CRM host is unaffected: src/app/page.js already server-redirects
  // '/' to /login or the dashboard before this client gate ever runs.
  const isPublic = pathname === '/' || PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))

  // Protected route but no resolved user (expired/unresolved session, or
  // a transient profile-fetch miss in getCurrentUser). Previously the
  // chrome rendered anyway with user=null, producing a dead shell —
  // default "UN1T" logo, "Lead Management" subtitle, "User" footer and
  // an EMPTY nav (every permission check fails on a null user). Send them
  // to login instead, preserving where they were headed.
  useEffect(() => {
    if (!isPublic && !user) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname || '/')}`)
    }
  }, [isPublic, user, pathname, router])

  // Public pages: render bare, no sidebar/chrome.
  if (isPublic) {
    return <>{children}</>
  }

  // Protected route without a user: render nothing while the redirect
  // above runs, rather than flashing the empty authenticated shell.
  if (!user) {
    return null
  }

  // Repset three-tier shell selection — a page is PLATFORM-tier,
  // ACCOUNT-tier, or STUDIO (default), and the three are MUTUALLY
  // EXCLUSIVE. Both non-studio branches are pure additions: on a studio
  // path both flags are false and the chrome renders byte-for-byte as
  // before, so the studio CRM is completely untouched.
  //
  // REPSET-PLATFORM.1 — platform-tier (the eight /admin console pages,
  // ADMIN.2h Task 2) gets the master console shell. Gated on BOTH the path AND
  // `user.isMaster`: a non-master who somehow hits a console path falls
  // through to the normal shell (and the page's own master guard then
  // redirects them), so this branch only ever engages for masters.
  // REPSET-ACCOUNT.2 — account-tier (/portfolio) gets the org shell.
  // `!isPlatformTier` on the account line makes the exclusion explicit
  // (the path sets are already disjoint, so it's defensive, not load-
  // bearing). The studio-only widgets (⌘K palette, AI assistant bubble)
  // are studio-context tools, so they don't mount at either tier.
  const isPlatformTier = !!user.isMaster && isPlatformTierPath(pathname)
  const isAccountTier = !isPlatformTier && isAccountTierPath(pathname)

  return (
    <div className="flex h-screen overflow-hidden bg-un1t-bg">
      {/* A11Y (WCAG 2.4.1 Bypass Blocks) — keyboard/screen-reader users can
          jump past the sidebar straight to <main>. Visually hidden until
          focused, then pinned top-left. Targets the #main-content id below. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-un1t-text focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-un1t-bg focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 px-4 h-14 bg-un1t-surface border-b border-un1t-border">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="p-1.5 -ml-1.5 text-un1t-text"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span className="font-bold tracking-wider text-un1t-text">
          {isPlatformTier
            ? 'Repset · Platform'
            : isAccountTier
              ? (user?.activeOrganization?.name || 'Account')
              : (user?.activeLocation?.name || 'UN1T')}
        </span>
      </div>

      {isPlatformTier ? (
        /* Platform tier — master cross-tenant console shell. */
        <PlatformShell user={user} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      ) : isAccountTier ? (
        /* Account tier — org-level nav shell. */
        <AccountShell user={user} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      ) : (
        <>
          {/* Global ⌘K command palette — search/jump/create from anywhere. */}
          <CommandPalette user={user} />

          {/* Sidebar */}
          <Sidebar user={user} isLinkedHost={isLinkedHost} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
        </>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* SUPPORT-ACCESS — a tenant support session takes precedence over
            the plain impersonation banner (a read-only support session
            impersonates the tenant owner, so `impersonatingFrom` is also
            set; we show the mode-aware SupportBanner instead of the
            generic "Viewing as" bar). Falls back to the impersonation
            banner for ordinary "view as user" sessions.
            `impersonatingFrom` is null for a normal session (incl. a master
            on their own profile) — auth.js only sets it for a genuine
            cross-user impersonation backed by an open audit row. */}
        {user?.supportSession
          ? <SupportBanner user={user} />
          : user?.impersonatingFrom && <ImpersonationBanner user={user} />}
        {/* CONTRACTS-SIGN.1 — global unsigned-contract alert (first-load
            modal, then a persistent top banner). Re-mounted here after it
            was dropped as collateral in the null-user redirect refactor
            (commit d1842096), which is why recipients stopped being
            prompted to sign. It fetches the caller's OWN pending contracts
            and hides itself on /account/contracts. */}
        <PendingContractsAlert />
        {/* Keying the page subtree on the active location remounts it
            when the location switches. The Sidebar already updates from
            the refreshed `user` prop, but client components inside a
            page fetch their data once on mount and won't re-run on a
            plain router.refresh() — so the main view stayed on the old
            location until a manual reload. The key changes only on a
            location switch (not on normal navigation), so it forces the
            re-fetch exactly when it's needed. Fragment = no extra DOM,
            zero layout impact. */}
        <main id="main-content" className="flex-1 overflow-y-auto pt-14 md:pt-0">
          <Fragment key={user?.activeLocation?.id ?? 'no-location'}>
            {children}
          </Fragment>
        </main>
      </div>

      {/* Permission-gated AI assistant chat bubble (fixed bottom-right,
          viewport-anchored). `user` is guaranteed non-null here — the
          !user early-return above is the d184209 redirect fix, so this
          mount can never resurrect the null-user dead-shell bug. Both
          this mount and the two Vercel scripts below were accidental
          casualties of the d184209 AppShell rewrite (restored 2026-06,
          platform audit). */}
      {!isAccountTier && !isPlatformTier && hasPermission(user, 'assistant') && <AssistantBubble user={user} />}

      {/* PERF.3 — Speed Insights + Analytics only on authenticated
          pages. Public surfaces return before this branch. */}
      <SpeedInsights />
      <Analytics />
    </div>
  )
}

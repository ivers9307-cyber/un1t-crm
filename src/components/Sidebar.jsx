'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Activity, ExternalLink, X, ChevronDown, ChevronRight as ChevronRightIcon, Store, Search } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import LocationSwitcher from './LocationSwitcher'
import ImpersonatePicker from './ImpersonatePicker'
import clsx from 'clsx'
import { hasPermission } from '@/lib/permissions'
import { usePolledCount } from './use-polled-count'
import { ALL_NAV, NAV_SECTIONS, DASHBOARD_LINK_PERM_KEYS, activeHrefFor } from '@/lib/nav-items'

const roleLabels = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// SIDEBAR-IA.1 — the nav structure (items, sections, the Dashboard
// link's permission keys) lives in src/lib/nav-items.js as a tested
// policy contract. This component only filters it per-user and
// renders it.

// The polled-count hook lives in use-polled-count.js (extracted so the
// Communications tab strip shares the exact same poller for its Inbox
// badge). Polls every 60s and refreshes on tab refocus. HOME.3 retired
// the sidebar's own per-item red-circle badges (8 pollers, one per
// nav item) — the needs-attention queue on /dashboard/today is the
// per-source breakdown now. MAIL-BADGE.1 and NAV-BADGE.1 since restored
// exactly two of those rows (Messages, Approvals) on narrow terms — see
// navBadges below. The tab title prefix sums whatever pills are visible.

export default function Sidebar({ user, isLinkedHost = false, mobileOpen = false, onMobileClose }) {
  const pathname = usePathname()
  const router = useRouter()
  const [branding, setBranding] = useState(null)

  // Load branding (logo) for current location
  useEffect(() => {
    if (!user?.activeLocation?.id) return
    fetch(`/api/settings/branding?location_id=${user.activeLocation.id}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setBranding(data.data)
          // Also set favicon if available
          if (data.data.favicon_url) {
            let link = document.querySelector("link[rel~='icon']")
            if (!link) {
              link = document.createElement('link')
              link.rel = 'icon'
              document.head.appendChild(link)
            }
            link.href = data.data.favicon_url
          }
        }
      })
      .catch(() => {})
  }, [user?.activeLocation?.id])

  // Permission resolver — same three-tier check as the server uses
  // (src/lib/permissions.js#hasPermission):
  //   1. master bypass         (mig 033)
  //   2. location feature gate (mig 032)
  //   3. user override → role default
  // Calling the shared helper instead of a local copy keeps the
  // sidebar honest about location-disabled features (e.g. CCF Autos
  // hides everything except Car Processing for non-master users).
  const hasPerm = (key) => hasPermission(user, key)

  // HOME.3 retired eight per-item nav badges (invoices, approvals, churn
  // radar, lead radar, issues, WhatsApp, email tickets, host events)
  // because each was a separate poller duplicating a count
  // /dashboard/today already computed. MAIL-BADGE.1
  // restored Messages on narrow terms; NAV-BADGE.1 restores Approvals on the
  // same ones. Net polled URLs are unchanged at three — this one replaces the
  // /api/home-queue/count poller rather than joining it.
  //
  // `enabled: !!user && hasPerm('approvals_inbox')` — the SAME key the
  // /approvals row itself gates on (src/lib/nav-items.js). This used to be
  // a bare `!!user`, reasoned as: a client-side hasPermission would check
  // approvals_inbox (the nav row's key) — a different question from what
  // any given provider actually gates on (of the eleven registered
  // providers in src/lib/approvals/registry.js, eight carry their own
  // distinct approvals_* permissionKey; the other three — invoices_queue,
  // issues, host_events — have none and gate via their own isVisible()
  // instead), so a client-side gate here could hide a badge for work the
  // caller really has.
  //
  // That stopped being true once titleCount started reducing over `nav`
  // (the permission-filtered list) instead of summing the raw poll counts:
  // nothing can render a pill OR contribute to the title without the
  // /approvals row surviving that filter, and the row's own gate is
  // exactly hasPerm('approvals_inbox') — the SAME call this poller now
  // makes. So the client gate and the row gate are the same question, not
  // two different ones, and gating here cannot hide anything the row
  // itself would show. This also stops a request every 60s for every
  // staff/non-approver session, and it makes the file internally
  // consistent — the WhatsApp poller a few lines below already gates on
  // its own key.
  //
  // The endpoint still self-gates independently underneath and answers 0
  // cheaply either way: isProviderVisible runs before any query, so a
  // staff session makes zero APPROVALS database calls (withAuth still
  // resolves the session itself first — that part isn't free, just not an
  // approvals query). That makes this client gate an OPTIMISATION, not the
  // security boundary — the boundary is, and remains, the endpoint's own
  // gate.
  const approvalsBadge = usePolledCount({
    enabled: !!user && hasPerm('approvals_inbox'),
    url: '/api/approvals/count',
  })

  // MAIL-BADGE.1 (Richard, 2 Sep) — the Messages row gets its badge back,
  // deliberately narrower than the HOME.3 apparatus this replaces a corner
  // of: ONE row, TWO pollers, and the numbers are exactly the hub's own
  // (WhatsApp unread + Mail needs-reply) so the sidebar and the tabs it
  // opens can never disagree. Mail counts the ESTATE (?scope=all — the
  // multi-location surface), not just the active studio: a Hatch
  // needs-reply must badge while the session sits on Stillorgan. The mail
  // poller is enabled whenever a user exists because the estate-wide
  // eligibility cannot be resolved client-side (hasPermission reads the
  // ACTIVE location only) — the endpoint self-gates and answers 0 cheaply.
  const waBadgeCount = usePolledCount({
    enabled: !!user && hasPermission(user, 'whatsapp'),
    url: '/api/whatsapp/unread-count',
  })
  const mailBadgeCount = usePolledCount({
    enabled: !!user,
    url: '/api/email/mail/count?scope=all',
  })
  const messagesBadge = (waBadgeCount || 0) + (mailBadgeCount || 0)

  // NAV-BADGE.1 — which rows carry a number. A row absent from this map gets
  // no pill. Keep it a map, not a chain of ternaries at the render site.
  const navBadges = {
    '/communications': messagesBadge,
    '/approvals': approvalsBadge,
  }

  // Match-permission predicate. Used both for top-level items and
  // for children of expandable sections.
  //   - dashboardGroup: any of dashboard_personal/studio/business
  //     or the radar keys (radars are dashboard tabs — SIDEBAR-IA.1)
  //   - anyPermission: any of the listed keys (e.g. communications
  //     shows if either email OR whatsapp is held)
  //   - permission (default): the single key listed
  //   - masterOrOwnerOnly / masterOnly: legacy role-only gates,
  //     retained for entries that never grew per-user permissions.
  // Privileged actions (staff management, branding, location config)
  // remain owner-only via separate role gates inside those pages.
  function matches(item) {
    if (item.openToAll) return !!user
    if (item.dashboardGroup) return DASHBOARD_LINK_PERM_KEYS.some(hasPerm)
    if (item.anyPermission) return item.anyPermission.some(hasPerm)
    if (item.masterOrOwnerOnly) return user?.role === 'master' || user?.role === 'owner'
    if (item.masterOnly) return user?.profileRole === 'master' || user?.role === 'master'
    return hasPerm(item.permission)
  }

  // Filter nav. Top-level items with children retain themselves +
  // their visible children if EITHER (a) the parent's own permission
  // is held, OR (b) at least one child is visible. This way an
  // operator who grants `contracts` to a head_coach (who normally
  // doesn't have `studio_management`) still sees the Studio
  // Management section in the sidebar with Contracts inside.
  const nav = ALL_NAV
    .map((item) => {
      if (!item.children) return item
      const visibleChildren = item.children.filter(matches)
      const parentVisible = matches(item) || visibleChildren.length > 0
      if (!parentVisible) return null
      return { ...item, _children: visibleChildren, _parentHasPerm: matches(item) }
    })
    .filter((item) => {
      if (!item) return false
      if (item.children) return true  // already filtered above
      return matches(item)
    })

  // NAV-BADGE.1 — the title sums the badges on the rows the user can
  // actually see: it reduces over `nav`, the SAME permission-filtered list
  // the render below walks, rather than re-deriving a parallel total from
  // the raw poll counts. That is what makes "title = sum of the visible
  // pills" an invariant rather than an aspiration — a row absent from `nav`
  // (a bookkeeper without approvals_inbox, or any approver at a location
  // where the Approvals feature card is off) contributes nothing to the
  // title either, because navBadges is only ever read back through this
  // same filtered list.
  //
  // /api/home-queue/count (the count route this replaced) has no callers
  // left in the app: /dashboard/today calls assembleHomeQueue(db, user)
  // directly (src/app/dashboard/today/page.js) and never fetches this
  // route. It stays published anyway — it's a registered OpenAPI endpoint.
  const titleCount = nav.reduce((sum, item) => sum + (navBadges[item.href] ?? 0), 0)

  // Browser tab title prefix — surfaces the pending count even when the
  // operator is on a different tab. Format: "(3) Repset · …". Restores
  // the original title on cleanup so a stale "(3)" doesn't survive a
  // navigation that triggers a Sidebar unmount.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const original = document.title.replace(/^\(\d+\+?\)\s+/, '')
    document.title = titleCount > 0
      ? `(${titleCount > 99 ? '99+' : titleCount}) ${original}`
      : original
    return () => {
      if (typeof document !== 'undefined') {
        document.title = document.title.replace(/^\(\d+\+?\)\s+/, '')
      }
    }
  }, [titleCount])

  // HUBS.2e Task 4 — ONE winner, longest match (activeHrefFor in
  // nav-items.js), computed once per render against the FILTERED nav
  // (a hidden item/child shouldn't claim the light — swap in the
  // permission-filtered `_children` for `children` before matching).
  // Replaces the old per-item bare startsWith (isPathActive) that let
  // every prefix-matching item light simultaneously.
  const active = activeHrefFor(pathname, nav.map((item) =>
    item.children ? { ...item, children: item._children } : item
  ))

  // STUDIO-GROUP.1 — expand/collapse state for the Studio Management
  // group, persisted to localStorage so it survives navigation. Auto-
  // opens the section if the current pathname matches the parent
  // href OR any child href (so deep-linking into a child shows the
  // operator their context).
  const [openGroups, setOpenGroups] = useState({})
  useEffect(() => {
    // Hydrate from localStorage on mount.
    try {
      const raw = window.localStorage.getItem('sidebar.openGroups')
      if (raw) setOpenGroups(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])
  // Persist on change.
  useEffect(() => {
    try {
      window.localStorage.setItem('sidebar.openGroups', JSON.stringify(openGroups))
    } catch { /* ignore */ }
  }, [openGroups])
  function toggleGroup(groupId) {
    setOpenGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
  }
  function isGroupOpen(item) {
    if (!item.groupId) return false
    // HUBS.2e Task 4 — auto-open exactly when this group is the ONE
    // winning entry (its own href, OR a child match — a child match
    // reports the parent's href as itemHref, so this still fires for a
    // deep link into a child). Same source of truth as the highlight,
    // rather than a second, separately-maintained match.
    const autoOpen = active?.itemHref === item.href
    return openGroups[item.groupId] ?? autoOpen
  }

  // Render a single nav entry — expandable group or leaf. Shared by
  // the pinned items and every section so the markup stays in one place.
  const renderNavItem = (item) =>
    item.children ? (
      <SidebarGroup
        key={item.href}
        item={item}
        active={active}
        open={isGroupOpen(item)}
        onToggle={() => toggleGroup(item.groupId)}
      />
    ) : (
      <SidebarItem
        key={item.href}
        item={item}
        active={active}
        badge={navBadges[item.href] ?? 0}
      />
    )

  async function handleLogout() {
    // Close any active impersonation session first so its audit row gets
    // a precise ended_at instead of dangling open until the reaper cron
    // catches it. Best-effort — never block logout on it.
    if (user?.impersonatingFrom) {
      try {
        await fetch('/api/impersonate/stop', { method: 'POST' })
      } catch {
        // ignore — the close-stale-impersonations cron is the backstop
      }
    }
    // MAIL-DRAFTSCOPE.2 — reply drafts used to be wiped here, because their
    // keys were per-TICKET and the next person to sign in on this browser
    // would have inherited them. The keys are now scoped per USER (and per
    // email account), which removes the reason: another login structurally
    // cannot hydrate this person's drafts, and NOT wiping is the point — a
    // returning operator finds their half-written reply where they left it,
    // bounded by the store's own 14-day TTL. clearAllReplyDrafts() still
    // exists in mail-display.js for a future explicit "clear drafts on this
    // device" affordance.
    const supabase = createBrowserClient()
    // scope:'local' — sign out THIS browser only. The supabase-js default
    // (scope:'global') revokes every session the user holds, so signing out
    // of e.g. the kiosk Mac shell also killed their phone + other browsers.
    await supabase.auth.signOut({ scope: 'local' })
    router.push('/login')
    router.refresh()
  }

  return (
    // Responsive shell:
    //   - md+ (desktop):  inline flex item, always visible (w-56)
    //   - below md:       fixed overlay drawer that slides in from
    //                     the left when mobileOpen is true
    // The transition class only animates on mobile (md:transition-none)
    // because the sidebar is never hidden on desktop and we don't
    // want a one-frame slide on first paint.
    <aside
      className={clsx(
        'w-64 md:w-56 bg-un1t-surface border-r border-un1t-border flex flex-col shrink-0',
        // Mobile-only overlay positioning + slide animation
        'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        // Desktop: cancel everything mobile-specific
        'md:relative md:translate-x-0 md:transition-none md:z-auto'
      )}
    >
      {/* Logo + Location + mobile close button */}
      <div className="p-5 border-b border-un1t-border">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {branding?.logo_url ? (
              <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-[54px] max-w-full object-contain" />
            ) : (
              <h1 className="text-xl font-bold tracking-wider">{branding?.company_name || 'UN1T'}</h1>
            )}
          </div>
          {/* Mobile-only close affordance — duplicates the backdrop
              tap-to-close so users with a trackpad / mouse on a
              narrow window can also dismiss without overshooting. */}
          <button
            onClick={onMobileClose}
            aria-label="Close menu"
            className="md:hidden p-1.5 -m-1 text-un1t-subtle hover:text-un1t-text rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-1">
          {user?.locations?.length > 1 ? (
            <LocationSwitcher
              locations={user.locations}
              activeLocationId={user.activeLocation?.id}
            />
          ) : (
            <p className="text-xs text-un1t-subtle">
              {user?.activeLocation?.name || 'Lead Management'}
            </p>
          )}
        </div>
      </div>

      {/* FEAT-LAUNCH.1 — visible ⌘K launcher trigger. The palette is mounted in
          AppShell and listens for this event, so operators who don't know the
          keyboard shortcut can still open it. */}
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-un1t-bg border border-un1t-border text-sm text-un1t-subtle hover:text-un1t-text hover:border-un1t-muted transition-colors"
        >
          <Search size={14} className="shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="hidden md:inline text-[10px] border border-un1t-border rounded px-1.5 py-0.5">⌘K</kbd>
        </button>
      </div>

      {/* Navigation — Dashboard pinned at top, then labelled sections.
          A section header renders only when the section has at least one
          item visible to this user (no empty headers). */}
      <nav className="flex-1 min-h-0 overflow-y-auto py-4">
        {nav.filter((item) => !item.section).map(renderNavItem)}
        {NAV_SECTIONS.map((section) => {
          const items = nav.filter((item) => item.section === section.id)
          if (items.length === 0) return null
          return (
            <div key={section.id} className="mt-1">
              {section.label && <SectionHeader label={section.label} />}
              {items.map(renderNavItem)}
            </div>
          )
        })}
      </nav>

      {/* HOST-PORTAL.5 — "Host portal" jump-link for a linked staff-host
          (this login also holds a host_users row, resolved server-side in
          AppShellServer as isLinkedHost). Gated on isLinkedHost, NOT a
          permission — so it lives OUTSIDE the ALL_NAV permission filter.
          Static internal href → next/link. Reuses leafClassName so it
          renders like any other leaf nav link, plus a top border to set it
          apart from the scrollable nav above. */}
      {isLinkedHost && (
        <Link
          href="/host"
          className={clsx(leafClassName(pathname === '/host' || pathname.startsWith('/host/')), 'border-t border-un1t-border')}
          title="Open the event host portal for a host linked to your login"
        >
          <Store size={18} />
          Event Host Portal
        </Link>
      )}

      {/* FU-PLATFORM-LINK — master-only Platform console link.
          Used to point ONLY at the external platform.un1tdublin.com
          (the comment here previously mislabelled it "Sentinel ops
          dashboard" / un1t-sentinel — it's actually the OLD, separate
          un1t-platform app: a stale deployment holding the prod
          service-role key, tagged for retirement in
          docs/INFRA_BACKLOG.md #5). The in-app Platform console (8
          pages — tenants/plans/domains/health/matrix/bridges/studio-
          devices/webhook-dead-letter — src/lib/platform-nav.js) has
          shipped at /admin/tenants since, but never got a sidebar
          entry of its own, so masters had no persistent path to their
          own console. Repointed internally; the legacy app keeps a
          smaller secondary link below rather than being stranded,
          since docs/INFRA_BACKLOG.md #5's "confirm nobody relies on
          /cost, /alerts, /balances" step hasn't run yet. No feature
          gate, no permission key, role-only, same as before. */}
      {user?.role === 'master' && (
        <Link
          href="/admin/tenants"
          className="flex items-center gap-3 px-5 py-2.5 text-sm transition-colors text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30 border-l-2 border-transparent border-t border-un1t-border"
          title="Platform console — tenants, plans, health, feature matrix (master-only)"
        >
          <Activity size={18} />
          Platform console
        </Link>
      )}
      {user?.role === 'master' && (
        <a
          href="https://platform.un1tdublin.com"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-5 py-1.5 text-xs transition-colors text-un1t-muted hover:text-un1t-subtle hover:bg-un1t-border/30 border-l-2 border-transparent"
          title="Legacy standalone ops app — pending retirement, see docs/INFRA_BACKLOG.md #5 (master-only, opens in new tab)"
        >
          <ExternalLink size={13} />
          Legacy platform
        </a>
      )}

      {/* Master-only impersonation picker. Visible while a real
          master session is active, OR while currently impersonating
          (so the master can cycle to a different user without
          stopping first). */}
      {(user?.role === 'master' || user?.impersonatingFrom) && (
        <div className="border-t border-un1t-border py-2">
          <ImpersonatePicker />
        </div>
      )}

      {/* User + Logout. Click the name/role block to jump to /account
          for self-service preferences (default landing page, access
          history, …). The sign-out button stays a sibling so muscle
          memory is unchanged. */}
      <div className="border-t border-un1t-border p-4">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/account"
            className="min-w-0 flex-1 -m-1 p-1 rounded hover:bg-un1t-border/40 transition-colors"
            title="Account preferences"
          >
            <p className="text-sm font-medium truncate">{user?.full_name || 'User'}</p>
            <p className="text-xs text-un1t-subtle truncate">{roleLabels[user?.role] || user?.role || ''}</p>
          </Link>
          <button
            onClick={handleLogout}
            className="p-1.5 text-un1t-subtle hover:text-un1t-text transition-colors rounded hover:bg-un1t-border/50 shrink-0"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

// ----- Sidebar item renderers ------------------------------------
// Pulled out into small components so the main Sidebar map() stays
// readable. SidebarItem handles a single leaf nav entry; SidebarGroup
// handles a parent + chevron + indented children list; SectionHeader
// is the small uppercase label above each group.

function SectionHeader({ label }) {
  return (
    <p className="px-5 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-un1t-muted">
      {label}
    </p>
  )
}

function leafClassName(active, isChild = false) {
  return clsx(
    'flex items-center gap-3 text-sm transition-colors',
    isChild ? 'pl-12 pr-5 py-2' : 'px-5 py-2.5',
    active
      ? 'text-un1t-text bg-un1t-border/50 border-l-2 border-un1t-text'
      : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30 border-l-2 border-transparent'
  )
}

function SidebarItem({ item, active, isChild = false, badge = 0 }) {
  const { href, label, icon: Icon, openInNewTab } = item
  // HUBS.2e Task 4 — ONE winner, longest match. A top-level item tints
  // when it IS the winning entry (active.itemHref); a child row tints
  // when it's specifically the matched path (active.matchedPath) — a
  // child match reports the PARENT's href as itemHref, so checking
  // itemHref alone would tint every child of an active group.
  const isActive = isChild ? active?.matchedPath === href : active?.itemHref === href
  const className = leafClassName(isActive, isChild)
  // Review fix (2026-08-15) — aria-current is stricter than the tint:
  // WAI-ARIA means exactly ONE element may claim aria-current="page", but
  // a group's parent row and its lit child both used to satisfy the same
  // itemHref check, so a child page (e.g. /presentations/xyz) announced
  // TWO "current pages". A child row's own isActive check already IS the
  // matchedPath===href test, so it's already exactly-one-correct — kept
  // as-is here. A genuine top-level leaf (no children — an item with
  // children always renders via SidebarGroup, never reaches this
  // component as a non-child) has no sibling child row to collide with,
  // so it claims aria-current whenever it's the winning entry, same as
  // its tint. The `!item.children` guard documents that invariant rather
  // than changing behaviour.
  const isAriaCurrent = isChild ? isActive : (isActive && !item.children)
  // HOME.3 retired the original per-item notification-pill badge
  // (INVOICES.2) along with the badges map that fed it; the
  // needs-attention queue on /dashboard/today is where per-source counts
  // live now. MAIL-BADGE.1 and NAV-BADGE.1 since restored a pill for
  // exactly two rows (Messages, Approvals) via the `badge` prop below —
  // see navBadges in Sidebar().
  if (openInNewTab) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon size={isChild ? 14 : 18} />
        {label}
        <ExternalLink size={11} className="opacity-60 ml-1" />
        {/* Review fix — this branch used to render with no `badge` at all.
            Dead today (nav-items.js has no openInNewTab row with a badge
            entry in navBadges), but titleCount reduces over `nav`
            regardless of which branch renders a row, so a future badged
            open-in-new-tab row would silently contribute to the title
            while showing no pill here. Mirrors the Link branch below. */}
        {badge > 0 && (
          <>
            <span
              data-testid="nav-badge"
              aria-hidden="true"
              className="ml-auto rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700"
            >
              {badge > 99 ? '99+' : badge}
            </span>
            <span className="sr-only">
              {`${badge} ${badge === 1 ? 'item needs' : 'items need'} your attention`}
            </span>
          </>
        )}
      </a>
    )
  }
  return (
    <Link href={href} className={className} aria-current={isAriaCurrent ? 'page' : undefined}>
      <Icon size={isChild ? 14 : 18} />
      {label}
      {/* MAIL-BADGE.1 / NAV-BADGE.1 — outstanding items in this section
          (today: Messages, Approvals — see navBadges in Sidebar()). Hidden
          at zero; a failed poll keeps the last good number upstream, so
          this never renders a confident 0 off a blip. The number alone
          announces as "Approvals 7", which could be a count of anything —
          the accessible text says what it counts. It is NOT capped like
          the visible text: "99+ items" is fine to hear.

          Review fix — `aria-label` used to sit directly on this span, but
          a bare <span>'s implicit role is `generic`, and ARIA 1.2
          prohibits naming a `generic` element: it only "worked" because
          the parent <Link>'s accessible-name recursion happened to pick up
          a descendant's aria-label anyway. Robust idiom instead:
          `aria-hidden` the visible pill (so its capped digits don't also
          get read literally) and carry the real, uncapped text in a
          sibling sr-only span — that text is picked up by the Link's
          name-from-content the same way any other visible text would be. */}
      {badge > 0 && (
        <>
          <span
            data-testid="nav-badge"
            aria-hidden="true"
            className="ml-auto rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700"
          >
            {badge > 99 ? '99+' : badge}
          </span>
          <span className="sr-only">
            {`${badge} ${badge === 1 ? 'item needs' : 'items need'} your attention`}
          </span>
        </>
      )}
    </Link>
  )
}

function SidebarGroup({ item, active, open, onToggle }) {
  const { href, label, icon: Icon, _children: children, _parentHasPerm: parentHasPerm } = item
  // HUBS.2e Task 4 — the group's own row TINTS (visual active class)
  // when the group IS the winning entry, same rule as a top-level
  // SidebarItem — deliberately including a child match (a child match
  // reports the parent's href as itemHref), so the section still reads
  // as "you're in here" while a child row is the literal match.
  const parentActive = active?.itemHref === href
  // Review fix (2026-08-15) — aria-current is stricter than the tint:
  // exactly one element may claim aria-current="page" (WAI-ARIA — two
  // "current pages" is a screen-reader contradiction). Confirmed live on
  // /presentations/xyz: both this parent row (itemHref match) and the
  // Presentations child row (matchedPath match) carried aria-current
  // together. The parent now only claims it when its OWN href is the
  // matched path — i.e. no child is the more specific match — leaving
  // the lit child (SidebarItem's isAriaCurrent) as the sole claimant
  // whenever a child is what actually matched.
  const parentIsAriaCurrent = active?.matchedPath === href
  const Chevron = open ? ChevronDown : ChevronRightIcon
  // SIDEBAR-CHEVRON — only render the expand toggle when the user
  // actually has visible children. The filter step above (line 190)
  // can produce an empty _children array when the user has the
  // parent's permission but none of the child permissions —
  // previously the chevron rendered anyway and clicking it expanded
  // an empty list. Now treat that case as a plain leaf.
  const hasChildren = Array.isArray(children) && children.length > 0

  // Parent row: clickable link to /studio-management (if perm), or
  // an inert label if the user has no parent perm but can see a
  // child. The chevron is a separate clickable area so toggling the
  // section open/closed doesn't navigate the user away.
  return (
    <div>
      <div className="flex items-stretch">
        {parentHasPerm ? (
          <Link href={href} className={clsx(leafClassName(parentActive), 'flex-1')} aria-current={parentIsAriaCurrent ? 'page' : undefined}>
            <Icon size={18} />
            {label}
          </Link>
        ) : (
          // No parent perm — still surface the section header so the
          // user can find their accessible children. Render as a
          // plain row, not a link, with reduced opacity to hint at
          // the read-only state.
          <div className={clsx(leafClassName(false), 'flex-1 cursor-default opacity-80')}>
            <Icon size={18} />
            {label}
          </div>
        )}
        {hasChildren && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            className="px-3 text-un1t-subtle hover:text-un1t-text transition-colors"
          >
            <Chevron size={14} />
          </button>
        )}
      </div>
      {hasChildren && open && (
        <div>
          {children.map((child) => (
            <SidebarItem key={child.href} item={child} active={active} isChild />
          ))}
        </div>
      )}
    </div>
  )
}

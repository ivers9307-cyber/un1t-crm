'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Activity, ExternalLink, X, ChevronDown, ChevronRight as ChevronRightIcon } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import LocationSwitcher from './LocationSwitcher'
import ImpersonatePicker from './ImpersonatePicker'
import clsx from 'clsx'
import { hasPermission } from '@/lib/permissions'
import { usePolledCount } from './use-polled-count'
import { ALL_NAV, NAV_SECTIONS, DASHBOARD_LINK_PERM_KEYS } from '@/lib/nav-items'

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

// Sidebar badge polling lives in use-polled-count.js (extracted so the
// Communications tab strip shares the exact same poller for its Inbox
// badge). Drives the red circles next to nav items that surface
// pending counts; polls every 60s and refreshes on tab refocus.

export default function Sidebar({ user, mobileOpen = false, onMobileClose }) {
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

  // INVOICES.2 + APPROVALS.1 — poll only for users who can see each
  // surface. The API short-circuits to 0 for others, but skipping
  // the fetch entirely saves 60 RPM × every-staff-session.
  const invoicesPendingCount = usePolledCount({
    enabled: hasPerm('invoices_inbox'),
    url: '/api/invoices-inbox/unread-count',
  })
  const approvalsPendingCount = usePolledCount({
    enabled: hasPerm('approvals_inbox'),
    url: '/api/approvals/count',
  })
  // CHURN-RADAR.1 / LEAD-RADAR.1 — high-risk + high-tier funnel
  // counts. The radars are dashboard tabs since SIDEBAR-IA.1, so the
  // two counts combine into one badge on the Dashboard entry — the
  // glance signal survives the relocation; the per-radar split lives
  // one click away on the tab strip.
  const churnRadarCount = usePolledCount({
    enabled: hasPerm('churn_radar'),
    url: '/api/churn-radar/count',
  })
  const leadRadarCount = usePolledCount({
    enabled: hasPerm('lead_radar'),
    url: '/api/lead-radar/count',
  })
  // SIDEBAR-BADGES.1 — Issues badge: open + in_progress staff-reported
  // issues awaiting a handler at the active location.
  const issuesPendingCount = usePolledCount({
    enabled: hasPerm('issues_inbox'),
    url: '/api/issues/count',
  })
  // SIDEBAR-BADGES.2 — Communications badge: conversations NEEDING ACTION
  // (unresolved WhatsApp + Instagram threads awaiting a reply or handed off
  // by the agent) at the active location. Not raw unread — an opened-but-
  // unanswered or handed-off thread must still badge. See the count endpoint.
  const communicationsActionCount = usePolledCount({
    enabled: hasPerm('whatsapp'),
    url: '/api/whatsapp/unread-count',
  })
  // Badge map by href. Add more entries here when another nav item
  // needs a notification dot.
  const badges = {
    '/dashboard': churnRadarCount + leadRadarCount,
    '/invoices': invoicesPendingCount,
    '/approvals': approvalsPendingCount,
    '/issues': issuesPendingCount,
    '/communications': communicationsActionCount,
  }

  // Browser tab title prefix — surfaces the combined pending count
  // even when the operator is on a different tab. Format:
  // "(3) CF Studio · …". Combines the operator-action queues
  // (INVOICES.2 + APPROVALS.1 + Issues) so the operator sees one
  // total rather than the prefix flickering between values; the
  // per-tab breakdown lives in the sidebar. WhatsApp unread is
  // deliberately excluded — it's a message inbox, not an action
  // queue, and would keep the title perpetually badged. Restores the
  // original title on cleanup so a stale "(3)" doesn't survive a
  // navigation that triggers a Sidebar unmount.
  const titleBadgeCount = invoicesPendingCount + approvalsPendingCount + issuesPendingCount
  useEffect(() => {
    if (typeof document === 'undefined') return
    const original = document.title.replace(/^\(\d+\+?\)\s+/, '')
    document.title = titleBadgeCount > 0
      ? `(${titleBadgeCount > 99 ? '99+' : titleBadgeCount}) ${original}`
      : original
    return () => {
      if (typeof document !== 'undefined') {
        document.title = document.title.replace(/^\(\d+\+?\)\s+/, '')
      }
    }
  }, [titleBadgeCount])

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
    // Auto-open if URL is the parent or any of its children.
    const autoOpen = pathname === item.href
      || (item._children || []).some((c) => pathname === c.href || (c.href !== '/' && pathname.startsWith(c.href)))
    return openGroups[item.groupId] ?? autoOpen
  }

  // Render a single nav entry — expandable group or leaf. Shared by
  // the pinned items and every section so the markup stays in one place.
  const renderNavItem = (item) =>
    item.children ? (
      <SidebarGroup
        key={item.href}
        item={item}
        pathname={pathname}
        open={isGroupOpen(item)}
        onToggle={() => toggleGroup(item.groupId)}
      />
    ) : (
      <SidebarItem
        key={item.href}
        item={item}
        pathname={pathname}
        badge={badges[item.href] || 0}
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
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
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

      {/* Master-only Platform link. Opens the standalone ops
          dashboard at platform.un1tdublin.com in a new tab —
          alerts, balances, cost tracking, approve/decline.
          Lives on a separate Vercel project + Supabase
          (un1t-sentinel) so it stays reachable during a CRM
          outage. No feature gate, no permission key, role-only. */}
      {user?.role === 'master' && (
        <a
          href="https://platform.un1tdublin.com"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 px-5 py-2.5 text-sm transition-colors text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/30 border-l-2 border-transparent border-t border-un1t-border"
          title="Sentinel ops dashboard (master-only, opens in new tab)"
        >
          <Activity size={18} />
          Platform
          <ExternalLink size={11} className="ml-auto opacity-60" />
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

function isPathActive(pathname, href, extraActivePaths) {
  return pathname === href
    || (href !== '/' && pathname.startsWith(href))
    || (extraActivePaths || []).some((p) => pathname.startsWith(p))
}

function SidebarItem({ item, pathname, isChild = false, badge = 0 }) {
  const { href, label, icon: Icon, extraActivePaths, openInNewTab } = item
  const active = isPathActive(pathname, href, extraActivePaths)
  const className = leafClassName(active, isChild)
  // INVOICES.2 — notification badge. Renders to the right of the
  // label with `ml-auto`. Capped at 99+ to stop the pill stretching
  // the sidebar layout. Hidden when the count is zero.
  const badgeNode = badge > 0 ? (
    <span
      aria-label={`${badge} pending`}
      className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-red-500 text-white"
    >
      {badge > 99 ? '99+' : badge}
    </span>
  ) : null
  if (openInNewTab) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon size={isChild ? 14 : 18} />
        {label}
        {badgeNode}
        <ExternalLink size={11} className="opacity-60 ml-1" />
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      <Icon size={isChild ? 14 : 18} />
      {label}
      {badgeNode}
    </Link>
  )
}

function SidebarGroup({ item, pathname, open, onToggle }) {
  const { href, label, icon: Icon, extraActivePaths, _children: children, _parentHasPerm: parentHasPerm } = item
  const parentActive = isPathActive(pathname, href, extraActivePaths)
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
          <Link href={href} className={clsx(leafClassName(parentActive), 'flex-1')}>
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
            <SidebarItem key={child.href} item={child} pathname={pathname} isChild />
          ))}
        </div>
      )}
    </div>
  )
}

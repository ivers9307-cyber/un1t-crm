'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Calendar, MessagesSquare, CalendarClock, Settings, LogOut, Car, Flag, Receipt, DoorOpen, Activity, ExternalLink, X, FileSignature, Heart, Globe, Download, Tv, ChevronDown, ChevronRight as ChevronRightIcon, BookOpen, Inbox } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import LocationSwitcher from './LocationSwitcher'
import ImpersonatePicker from './ImpersonatePicker'
import clsx from 'clsx'
import { hasPermission } from '@/lib/permissions'

const roleLabels = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

// The 3 dashboard sub-permissions — the sidebar Dashboard link is
// visible if ANY are true. Sub-page selection happens via the
// segmented control at the top of /dashboard/* pages.
const DASHBOARD_PERM_KEYS = ['dashboard_personal', 'dashboard_studio', 'dashboard_business']

const allNav = [
  { href: '/dashboard',  label: 'Dashboard',   icon: LayoutDashboard, dashboardGroup: true },
  { href: '/pipeline',   label: 'Pipeline',    icon: Columns3,        permission: 'pipeline' },
  { href: '/contacts',   label: 'Contacts',    icon: Users,           permission: 'contacts' },
  { href: '/activities', label: 'Tasks',        icon: CheckSquare,     permission: 'activities' },
  // Single "Calendly" entry replacing the old Events + Bookings.
  // The hub lands on /bookings (the high-frequency operational
  // view — "what's booked today / coming up") with a tab strip
  // at the top of both /bookings and /events that lets the
  // operator switch between booking types and reservations.
  // anyPermission means visible if EITHER permission is granted.
  // Renamed from "Calendly" → "Bookings" in E2 of the events
  // expansion, as part of freeing the word "Events" for the new
  // multi-kind events feature (race + workshop + seminar +
  // open_day + masterclass). The /events URL itself relocated to
  // /bookings/event-types — no extraActivePaths needed since both
  // tabs now live under /bookings/*.
  { href: '/bookings',   label: 'Bookings',     icon: Calendar,
    anyPermission: ['events', 'bookings'] },
  // Single Communications entry replacing the old Email + WhatsApp.
  // Visible if the user has EITHER permission — sub-tabs inside the
  // hub gate themselves further. Marked with a custom check function
  // since it ORs two permissions instead of requiring one.
  { href: '/communications', label: 'Communications', icon: MessagesSquare,
    anyPermission: ['email', 'whatsapp'] },
  // Schedule hub — single sidebar entry. Internal tab strip
  // (ScheduleTabs.jsx) holds Schedule / Approvals / Reporting /
  // Invoices / Attendance. The Attendance tab (mig 120 — auto-
  // stamped from UniFi Access door unlocks) used to be a top-level
  // sidebar entry; folded into the schedule tab strip in May 2026
  // because operationally it sits next to Invoices (both are
  // about staff time + pay). Same attendance_reports permission
  // gate; the standalone /schedule/attendance URL still works as
  // a deep link for cron-driven emails / scheduled reminders.
  { href: '/schedule',   label: 'Schedule',     icon: CalendarClock,   permission: 'schedule' },
  // Events (mig 082 origin, multi-kind from mig 122 onwards). Was
  // labelled "Races" before the events expansion — same data table
  // (race_events), now spans race + workshop + seminar + open_day +
  // masterclass via the kind discriminator. URL relocated /races →
  // /events; permission key 'races' stays internal (gates UI, not
  // user-visible). extraActivePaths keeps the entry highlighted on
  // old /events/* URLs that hit the back-compat rewrite.
  { href: '/events',     label: 'Events',       icon: Flag,            permission: 'races',
    extraActivePaths: ['/events'] },
  { href: '/cars',       label: 'Car Processing', icon: Car,           permission: 'car_processing' },
  // Orders (mig 085) spans all revenue streams (race signups + cars).
  // Got its own permission key in the mig-092 audit. Segments USED
  // to be a top-level entry too — moved under /communications/segments
  // because operators only ever come to segments to drive a broadcast.
  // The top-level entry is gone, the /segments URL still works
  // (legacy redirect).
  { href: '/orders',     label: 'Orders',       icon: Receipt,         permission: 'orders' },
  // INVOICES.1 — Dext-style email-in inbox. Master + owner only by
  // default. Per-location forwarding addresses are shown at the top
  // of the page; quality + data approvals run before forward-to-Xero.
  { href: '/invoices',   label: 'Invoices',     icon: Inbox,           permission: 'invoices_inbox' },
  // Studio Management — expandable section. Parent route
  // /studio-management renders the door-unlock panel (mig 093 cross-
  // platform key). The six children below used to be top-level
  // sidebar entries; STUDIO-GROUP.1 (May 2026) grouped them under
  // this section so the sidebar collapses operator/admin surfaces
  // that all relate to on-site studio operations. Each child has
  // its own per-user permission (mig: STUDIO-GROUP.1 added four
  // new keys — contracts, tv_displays, glofox_import,
  // preferences_import) so operators can grant access individually.
  {
    href: '/studio-management',
    label: 'Studio Management',
    icon: DoorOpen,
    permission: 'studio_management',
    groupId: 'studio',  // localStorage key for expand state
    children: [
      // Contracts (mig 106) — digital staff/contractor contracts.
      { href: '/admin/contracts',         label: 'Contracts',             icon: FileSignature, permission: 'contracts' },
      // TV.1 — TV display management. UC Cast Pro renders /tv/<token>.
      { href: '/admin/tv-displays',       label: 'TV Displays',           icon: Tv,            permission: 'tv_displays' },
      // GLOFOX2.3 — interactive Glofox member import + sync history.
      { href: '/admin/glofox-import',     label: 'Glofox import',         icon: Download,      permission: 'glofox_import' },
      // CONSENT.5 — bulk import of marketing preferences.
      { href: '/admin/marketing-import',  label: 'Preferences import',    icon: Download,      permission: 'preferences_import' },
      // Public landing page — preview link, opens in new tab.
      { href: '/welcome',                 label: 'Landing page',          icon: Globe,         permission: 'landing_page', openInNewTab: true },
      // Landing page settings — operator form for the /welcome page.
      { href: '/settings/landing-page',   label: 'Landing page settings', icon: Globe,         permission: 'landing_page' },
    ],
  },
  // Live class — coach view of in-studio HR (mig 110-113). Renders
  // attendees with current zone color, available straps panel, and
  // override-pairing flow. /live redirects to /live/<activeLocation>.
  // Same permission gate as Studio Management — anyone running
  // class can use it. Stays top-level rather than nested under
  // Studio Management because operationally it's its own surface
  // (live HR is a primary screen, not an admin task).
  { href: '/live', label: 'Live HR', icon: Heart, permission: 'studio_management' },
  // Policies (POLICIES.1) — versioned HR policies, open to every
  // authenticated employee. No permission gate; sidebar always shows
  // the entry to anyone signed in so they can find the documents
  // they're being asked to acknowledge.
  { href: '/policies',   label: 'Policies',     icon: BookOpen,        openToAll: true },
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings' },
]

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

  // Match-permission predicate. Used both for top-level items and
  // for children of expandable sections.
  //   - dashboardGroup: any of dashboard_personal/studio/business
  //   - anyPermission: any of the listed keys (e.g. communications
  //     shows if either email OR whatsapp is held)
  //   - permission (default): the single key listed
  //   - masterOrOwnerOnly / masterOnly: legacy role-only gates,
  //     retained for entries that never grew per-user permissions.
  // Privileged actions (staff management, branding, location config)
  // remain owner-only via separate role gates inside those pages.
  function matches(item) {
    if (item.openToAll) return !!user
    if (item.dashboardGroup) return DASHBOARD_PERM_KEYS.some(hasPerm)
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
  const nav = allNav
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

  async function handleLogout() {
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
        'w-64 md:w-56 bg-un1t-dark border-r border-un1t-gray flex flex-col shrink-0',
        // Mobile-only overlay positioning + slide animation
        'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        // Desktop: cancel everything mobile-specific
        'md:relative md:translate-x-0 md:transition-none md:z-auto'
      )}
    >
      {/* Logo + Location + mobile close button */}
      <div className="p-5 border-b border-un1t-gray">
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
            className="md:hidden p-1.5 -m-1 text-un1t-light hover:text-un1t-white rounded transition-colors"
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
            <p className="text-xs text-un1t-light">
              {user?.activeLocation?.name || 'Lead Management'}
            </p>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4">
        {nav.map((item) => {
          // Expandable parent (Studio Management). The parent label
          // navigates; a separate chevron toggles expand/collapse.
          if (item.children) {
            return (
              <SidebarGroup
                key={item.href}
                item={item}
                pathname={pathname}
                open={isGroupOpen(item)}
                onToggle={() => toggleGroup(item.groupId)}
              />
            )
          }
          return (
            <SidebarItem
              key={item.href}
              item={item}
              pathname={pathname}
            />
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
          className="flex items-center gap-3 px-5 py-2.5 text-sm transition-colors text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/30 border-l-2 border-transparent border-t border-un1t-gray"
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
        <div className="border-t border-un1t-gray py-2">
          <ImpersonatePicker />
        </div>
      )}

      {/* User + Logout. Click the name/role block to jump to /account
          for self-service preferences (default landing page, access
          history, …). The sign-out button stays a sibling so muscle
          memory is unchanged. */}
      <div className="border-t border-un1t-gray p-4">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/account"
            className="min-w-0 flex-1 -m-1 p-1 rounded hover:bg-un1t-gray/40 transition-colors"
            title="Account preferences"
          >
            <p className="text-sm font-medium truncate">{user?.full_name || 'User'}</p>
            <p className="text-xs text-un1t-light truncate">{roleLabels[user?.role] || user?.role || ''}</p>
          </Link>
          <button
            onClick={handleLogout}
            className="p-1.5 text-un1t-light hover:text-un1t-white transition-colors rounded hover:bg-un1t-gray/50 shrink-0"
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
// handles a parent + chevron + indented children list.

function leafClassName(active, isChild = false) {
  return clsx(
    'flex items-center gap-3 text-sm transition-colors',
    isChild ? 'pl-12 pr-5 py-2' : 'px-5 py-2.5',
    active
      ? 'text-un1t-white bg-un1t-gray/50 border-l-2 border-un1t-white'
      : 'text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/30 border-l-2 border-transparent'
  )
}

function isPathActive(pathname, href, extraActivePaths) {
  return pathname === href
    || (href !== '/' && pathname.startsWith(href))
    || (extraActivePaths || []).some((p) => pathname.startsWith(p))
}

function SidebarItem({ item, pathname, isChild = false }) {
  const { href, label, icon: Icon, extraActivePaths, openInNewTab } = item
  const active = isPathActive(pathname, href, extraActivePaths)
  const className = leafClassName(active, isChild)
  if (openInNewTab) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        <Icon size={isChild ? 14 : 18} />
        {label}
        <ExternalLink size={11} className="opacity-60 ml-1" />
      </a>
    )
  }
  return (
    <Link href={href} className={className}>
      <Icon size={isChild ? 14 : 18} />
      {label}
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
            className="px-3 text-un1t-light hover:text-un1t-white transition-colors"
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

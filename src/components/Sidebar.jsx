'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Calendar, MessagesSquare, CalendarClock, Settings, LogOut, Car, Flag, Receipt, DoorOpen, Activity, ExternalLink, X, FileSignature, Heart, Globe } from 'lucide-react'
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
  // Studio Management — mig 093 cross-platform key. Replaces the
  // mobile-only `door_unlock` flag. Surface today is remote door
  // unlock via UniFi; future on-site ops land here.
  { href: '/studio-management', label: 'Studio Management', icon: DoorOpen, permission: 'studio_management' },
  // Live class — coach view of in-studio HR (mig 110-113). Renders
  // attendees with current zone color, available straps panel, and
  // override-pairing flow. /live redirects to /live/<activeLocation>.
  // Same permission gate as Studio Management — anyone running
  // class can use it.
  { href: '/live', label: 'Live HR', icon: Heart, permission: 'studio_management' },
  // Contracts (mig 106) — digital staff/contractor contracts with
  // typed-name signatures. Master/owner only — no permission flag,
  // role-only gate (matches the API + RLS layer). Custom matcher
  // below uses the masterOrOwnerOnly key.
  { href: '/admin/contracts', label: 'Contracts', icon: FileSignature, masterOrOwnerOnly: true },
  // Public landing page — preview link for master/owner. Phase 1
  // is hand-coded React at /welcome; Phase 2 (mig 126) added the
  // sibling /settings/landing-page page below for editing hero copy /
  // booking-form slug / hero image / pillars / stats / testimonial
  // without a redeploy. The preview link opens in a new tab so the
  // operator can keep the settings form open while iterating.
  { href: '/welcome', label: 'Landing page', icon: Globe, masterOrOwnerOnly: true, openInNewTab: true },
  // Landing page settings — operator form for the /welcome page.
  // Master/owner only (matches the table's RLS write policy +
  // the API gate). Stays in the same tab — sits next to the preview
  // link above so the workflow is "open settings, click preview to
  // pop a tab, edit + save, reload the preview tab".
  { href: '/settings/landing-page', label: 'Landing page settings', icon: Globe, masterOrOwnerOnly: true },
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

  // Filter nav based on permissions. Three matching modes:
  //   - dashboardGroup: any of dashboard_personal/studio/business
  //   - anyPermission: any of the listed keys (e.g. communications
  //     shows if either email OR whatsapp is held)
  //   - permission (default): the single key listed
  // Privileged actions (staff management, branding, location config)
  // remain owner-only via separate role gates inside those pages.
  const nav = allNav.filter(item => {
    if (item.dashboardGroup) return DASHBOARD_PERM_KEYS.some(hasPerm)
    if (item.anyPermission) return item.anyPermission.some(hasPerm)
    if (item.masterOrOwnerOnly) return user?.role === 'master' || user?.role === 'owner'
    return hasPerm(item.permission)
  })

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
        {nav.map(({ href, label, icon: Icon, extraActivePaths, openInNewTab }) => {
          // Active when the URL matches the entry's href OR any of
          // the merged-feature aliases (e.g. /events highlights the
          // Calendly entry that points at /bookings).
          const active = pathname === href
            || (href !== '/' && pathname.startsWith(href))
            || (extraActivePaths || []).some(p => pathname.startsWith(p))

          // Public surfaces (e.g. the marketing landing page) open in
          // a new tab so the operator doesn't lose their CRM context
          // when previewing the customer-facing view. Uses a plain
          // <a> with target+rel rather than next/link prefetch since
          // we want a real new browser tab, not a soft client-side
          // navigation.
          const className = clsx(
            'flex items-center gap-3 px-5 py-2.5 text-sm transition-colors',
            active
              ? 'text-un1t-white bg-un1t-gray/50 border-l-2 border-un1t-white'
              : 'text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/30 border-l-2 border-transparent'
          )

          if (openInNewTab) {
            return (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer" className={className}>
                <Icon size={18} />
                {label}
                <ExternalLink size={11} className="opacity-60 ml-1" />
              </a>
            )
          }
          return (
            <Link key={href} href={href} className={className}>
              <Icon size={18} />
              {label}
            </Link>
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

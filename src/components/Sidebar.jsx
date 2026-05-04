'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Calendar, MessagesSquare, CalendarClock, Settings, LogOut, Car, Flag, Receipt } from 'lucide-react'
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
  // anyPermission means visible if EITHER permission is granted;
  // extraActivePaths keeps the nav item highlighted when the
  // user is on /events as well as /bookings.
  { href: '/bookings',   label: 'Calendly',     icon: Calendar,
    anyPermission: ['events', 'bookings'],
    extraActivePaths: ['/events'] },
  // Single Communications entry replacing the old Email + WhatsApp.
  // Visible if the user has EITHER permission — sub-tabs inside the
  // hub gate themselves further. Marked with a custom check function
  // since it ORs two permissions instead of requiring one.
  { href: '/communications', label: 'Communications', icon: MessagesSquare,
    anyPermission: ['email', 'whatsapp'] },
  { href: '/schedule',   label: 'Schedule',     icon: CalendarClock,   permission: 'schedule' },
  // Race events (mig 082) — standalone from booking events. Got its
  // own permission key in the mig-092 audit so locations that don't
  // run races can hide them without losing booking events.
  { href: '/races',      label: 'Races',        icon: Flag,            permission: 'races' },
  { href: '/cars',       label: 'Car Processing', icon: Car,           permission: 'car_processing' },
  // Orders (mig 085) spans all revenue streams (race signups + cars).
  // Got its own permission key in the mig-092 audit. Segments USED
  // to be a top-level entry too — moved under /communications/segments
  // because operators only ever come to segments to drive a broadcast.
  // The top-level entry is gone, the /segments URL still works
  // (legacy redirect).
  { href: '/orders',     label: 'Orders',       icon: Receipt,         permission: 'orders' },
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings' },
]

export default function Sidebar({ user }) {
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
    return hasPerm(item.permission)
  })

  async function handleLogout() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-56 bg-un1t-dark border-r border-un1t-gray flex flex-col shrink-0">
      {/* Logo + Location */}
      <div className="p-5 border-b border-un1t-gray">
        {branding?.logo_url ? (
          <img src={branding.logo_url} alt={branding.company_name || 'Logo'} className="h-8 max-w-[140px] object-contain" />
        ) : (
          <h1 className="text-xl font-bold tracking-wider">{branding?.company_name || 'UN1T'}</h1>
        )}
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
        {nav.map(({ href, label, icon: Icon, extraActivePaths }) => {
          // Active when the URL matches the entry's href OR any of
          // the merged-feature aliases (e.g. /events highlights the
          // Calendly entry that points at /bookings).
          const active = pathname === href
            || (href !== '/' && pathname.startsWith(href))
            || (extraActivePaths || []).some(p => pathname.startsWith(p))
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                'flex items-center gap-3 px-5 py-2.5 text-sm transition-colors',
                active
                  ? 'text-un1t-white bg-un1t-gray/50 border-l-2 border-un1t-white'
                  : 'text-un1t-light hover:text-un1t-white hover:bg-un1t-gray/30 border-l-2 border-transparent'
              )}
            >
              <Icon size={18} />
              {label}
            </Link>
          )
        })}
      </nav>

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

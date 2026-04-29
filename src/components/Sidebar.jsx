'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Calendar, BookOpen, Mail, MessageCircle, CalendarClock, Settings, LogOut } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import LocationSwitcher from './LocationSwitcher'
import clsx from 'clsx'

const roleLabels = {
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

const allNav = [
  { href: '/',           label: 'Dashboard',   icon: LayoutDashboard, permission: 'dashboard' },
  { href: '/pipeline',   label: 'Pipeline',    icon: Columns3,        permission: 'pipeline' },
  { href: '/contacts',   label: 'Contacts',    icon: Users,           permission: 'contacts' },
  { href: '/activities', label: 'Activities',   icon: CheckSquare,     permission: 'activities' },
  { href: '/events',     label: 'Events',       icon: Calendar,        permission: 'events' },
  { href: '/bookings',   label: 'Bookings',     icon: BookOpen,        permission: 'bookings' },
  { href: '/email',      label: 'Email',        icon: Mail,            permission: 'email' },
  { href: '/whatsapp',   label: 'WhatsApp',     icon: MessageCircle,   permission: 'whatsapp' },
  { href: '/schedule',   label: 'Schedule',     icon: CalendarClock,   permission: 'schedule' },
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings' },
]

export default function Sidebar({ user }) {
  const pathname = usePathname()
  const router = useRouter()
  const permissions = user?.permissions || {}
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

  // Filter nav based on permissions — owners see everything
  const nav = allNav.filter(item => {
    if (user?.role === 'owner') return true
    return permissions[item.permission] !== false
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
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/' && pathname.startsWith(href))
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

      {/* User + Logout */}
      <div className="border-t border-un1t-gray p-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user?.full_name || 'User'}</p>
            <p className="text-xs text-un1t-light truncate">{roleLabels[user?.role] || user?.role || ''}</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 text-un1t-light hover:text-un1t-white transition-colors rounded hover:bg-un1t-gray/50"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

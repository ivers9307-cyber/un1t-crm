'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Calendar, BookOpen, Settings, LogOut } from 'lucide-react'
import { createBrowserClient } from '@/lib/supabase'
import clsx from 'clsx'

const allNav = [
  { href: '/',           label: 'Dashboard',   icon: LayoutDashboard, permission: 'dashboard' },
  { href: '/pipeline',   label: 'Pipeline',    icon: Columns3,        permission: 'pipeline' },
  { href: '/contacts',   label: 'Contacts',    icon: Users,           permission: 'contacts' },
  { href: '/activities', label: 'Activities',   icon: CheckSquare,     permission: 'activities' },
  { href: '/events',     label: 'Events',       icon: Calendar,        permission: 'events' },
  { href: '/bookings',   label: 'Bookings',     icon: BookOpen,        permission: 'bookings' },
  { href: '/settings',   label: 'Settings',     icon: Settings,        permission: 'settings' },
]

export default function Sidebar({ user }) {
  const pathname = usePathname()
  const router = useRouter()
  const permissions = user?.permissions || {}

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
        <h1 className="text-xl font-bold tracking-wider">UN1T</h1>
        <p className="text-xs text-un1t-light mt-0.5">
          {user?.activeLocation?.name || 'Lead Management'}
        </p>
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
                  ? 'text-white bg-un1t-gray/50 border-l-2 border-white'
                  : 'text-un1t-light hover:text-white hover:bg-un1t-gray/30 border-l-2 border-transparent'
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
            <p className="text-xs text-un1t-light truncate">{user?.role || ''}</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 text-un1t-light hover:text-white transition-colors rounded hover:bg-un1t-gray/50"
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}

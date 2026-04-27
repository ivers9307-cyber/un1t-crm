'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Users, Columns3, CheckSquare, Search } from 'lucide-react'
import clsx from 'clsx'

const nav = [
  { href: '/',           label: 'Dashboard',  icon: LayoutDashboard },
  { href: '/pipeline',   label: 'Pipeline',   icon: Columns3 },
  { href: '/contacts',   label: 'Contacts',   icon: Users },
  { href: '/activities', label: 'Activities',  icon: CheckSquare },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="w-56 bg-un1t-dark border-r border-un1t-gray flex flex-col shrink-0">
      {/* Logo */}
      <div className="p-5 border-b border-un1t-gray">
        <h1 className="text-xl font-bold tracking-wider">UN1T</h1>
        <p className="text-xs text-un1t-light mt-0.5">Lead Management</p>
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

      {/* Footer */}
      <div className="p-4 border-t border-un1t-gray text-xs text-un1t-light">
        UN1T Dublin CRM v1.0
      </div>
    </aside>
  )
}

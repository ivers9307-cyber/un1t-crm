'use client'

// CalendlyTabs — top-of-page tab strip rendered on /bookings
// and /events. The two pages used to be separate sidebar
// entries; merging them under one "Calendly" sidebar entry
// means the operator needs an in-page way to switch between
// the operational view (Bookings — what's reserved) and the
// configuration view (Event types — what's bookable).
//
// Server-component-friendly: pulls the active tab from
// usePathname so each tab page gets its own active state for
// free with no prop plumbing.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar, BookOpen } from 'lucide-react'

const TABS = [
  { href: '/bookings', label: 'Bookings',     icon: Calendar,   description: 'Confirmed reservations' },
  { href: '/events',   label: 'Event types',  icon: BookOpen,   description: 'Bookable templates' },
]

export default function CalendlyTabs() {
  const pathname = usePathname()
  return (
    <div className="flex gap-1 mb-5 border-b border-un1t-gray">
      {TABS.map(tab => {
        const active = pathname === tab.href
          || (tab.href !== '/' && pathname.startsWith(tab.href + '/'))
        const Icon = tab.icon
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
              active
                ? 'border-un1t-white text-un1t-white font-medium'
                : 'border-transparent text-un1t-light hover:text-un1t-white'
            }`}
          >
            <Icon size={14} />
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}

'use client'

// CalendlyTabs — top-of-page tab strip rendered inside the
// /bookings hub. The hub has two views: the operational view
// (Bookings — what's reserved) and the configuration view
// (Booking types — what's bookable, formerly /events templates).
//
// Note: the configuration view URL relocated from /events to
// /bookings/event-types in E2 of the events expansion. The /events
// URL space is now reserved for the multi-kind events feature
// (race + workshop + seminar + open_day + masterclass). Old
// operator bookmarks against /events get a forever-rewrite in
// next.config.js.
//
// Server-component-friendly: pulls the active tab from
// usePathname so each tab page gets its own active state for
// free with no prop plumbing.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar, BookOpen } from 'lucide-react'

const TABS = [
  { href: '/bookings',              label: 'Bookings',     icon: Calendar,  description: 'Confirmed reservations' },
  { href: '/bookings/event-types',  label: 'Booking types', icon: BookOpen, description: 'Bookable templates' },
]

export default function CalendlyTabs() {
  const pathname = usePathname()
  // /bookings and /bookings/event-types overlap on prefix — the
  // booking-types route lives nested under /bookings/* now. Pick
  // the longest matching tab so the most-specific one wins
  // (otherwise both tabs light up on /bookings/event-types/*).
  const bestMatch = TABS
    .filter(t => pathname === t.href || (t.href !== '/' && pathname.startsWith(t.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]
  return (
    <div className="flex gap-1 mb-5 border-b border-un1t-border">
      {TABS.map(tab => {
        const active = bestMatch?.href === tab.href
        const Icon = tab.icon
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
              active
                ? 'border-un1t-text text-un1t-text font-medium'
                : 'border-transparent text-un1t-subtle hover:text-un1t-text'
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

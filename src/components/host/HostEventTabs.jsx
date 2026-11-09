'use client'

// The five tabs under a host event's header (HOSTPORTAL.2). GuardedLinks so a
// tab change asks first when a form is unsaved; the strip scrolls inside
// itself on a narrow phone. /edit (the old edit route) counts as Set up.

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import GuardedLink from '@/components/host/GuardedLink'

export const EVENT_TABS = [
  { key: 'overview', label: 'Overview', path: '' },
  { key: 'attendees', label: 'Attendees', path: '/attendees' },
  { key: 'setup', label: 'Set up', path: '/setup' },
  { key: 'promote', label: 'Promote', path: '/promote' },
  { key: 'insights', label: 'Insights', path: '/insights' },
]

/** Which tab a pathname belongs to; anything unrecognised falls to overview. */
export function activeTab(pathname, eventId) {
  const base = `/host/events/${eventId}`
  const rest = String(pathname || '').startsWith(base) ? String(pathname).slice(base.length).replace(/\/+$/, '') : ''
  if (rest === '/edit') return 'setup'
  const hit = EVENT_TABS.find((t) => t.path && t.path === rest)
  return hit ? hit.key : 'overview'
}

export default function HostEventTabs({ eventId, attendeeCount = null }) {
  const pathname = usePathname()
  const current = activeTab(pathname, eventId)
  const activeRef = useRef(null)
  // Keep the active tab visible inside the scrolling strip (as HostNav does).
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pathname])
  return (
    <nav aria-label="Event sections" className="mt-5 border-b border-white/10 overflow-x-auto">
      <ul className="flex gap-1 min-w-max">
        {EVENT_TABS.map((t) => {
          const active = t.key === current
          return (
            <li key={t.key}>
              <GuardedLink
                ref={active ? activeRef : undefined}
                href={`/host/events/${eventId}${t.path}`}
                aria-current={active ? 'page' : undefined}
                className={`block px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px ${active ? 'border-white text-white font-semibold' : 'border-transparent text-white/55 hover:text-white'}`}
              >
                {t.label}
                {t.key === 'attendees' && typeof attendeeCount === 'number' && (
                  <span className="ml-1.5 text-xs text-white/45">{attendeeCount}</span>
                )}
              </GuardedLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

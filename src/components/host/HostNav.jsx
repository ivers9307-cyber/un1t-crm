'use client'

// Host-portal header navigation (HOST-GROWTH.A). Persistent on every (portal)
// page: six places (Overview / Events / Contacts / Emails / Earnings / Your
// page) with an active state. It sits on its own full-width row under the
// brand row at every width and scrolls inside itself; the active link is
// scrolled into view so a place on the right is never off-screen on a phone.
// Client component only for usePathname and the scroll: no data fetching.

import { useEffect, useRef } from 'react'
import GuardedLink from './GuardedLink'
import { usePathname } from 'next/navigation'

export const LINKS = [
  { href: '/host', label: 'Overview', exact: true },
  { href: '/host/events', label: 'Events', exact: false },
  { href: '/host/contacts', label: 'Contacts', exact: false },
  { href: '/host/emails', label: 'Emails', exact: false },
  { href: '/host/earnings', label: 'Earnings', exact: false },
  { href: '/host/page', label: 'Your page', exact: false },
]

// Exact match for /host (otherwise it would light up on every page);
// prefix match for the sections so detail pages keep them active.
export function isNavActive(pathname, { href, exact }) {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function HostNav() {
  const pathname = usePathname() || ''
  const activeRef = useRef(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pathname])
  return (
    <nav aria-label="Host portal" className="order-last flex w-full items-center gap-1 overflow-x-auto whitespace-nowrap">
      {LINKS.map((l) => {
        const active = isNavActive(pathname, l)
        return (
          <GuardedLink
            key={l.href}
            ref={active ? activeRef : undefined}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${
              active
                ? 'bg-white/10 text-white font-semibold'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            {l.label}
          </GuardedLink>
        )
      })}
    </nav>
  )
}

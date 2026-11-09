'use client'

// Host-portal header navigation (HOST-GROWTH.A). Persistent on every
// (portal) page: six places (Overview / Events / Contacts / Emails / Earnings /
// Your page) with an active state, plus the prominent "+ Create event" CTA. Client component only for
// usePathname — no data fetching here.

import Link from 'next/link'
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
  return (
    <nav aria-label="Host portal" className="order-last flex w-full items-center gap-1 overflow-x-auto whitespace-nowrap sm:order-none sm:w-auto sm:min-w-0">
      {LINKS.map((l) => {
        const active = isNavActive(pathname, l)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${
              active
                ? 'bg-white/10 text-white font-semibold'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}

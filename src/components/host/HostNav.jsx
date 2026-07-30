'use client'

// Host-portal header navigation (HOST-GROWTH.A). Persistent on every
// (portal) page: Dashboard / Contacts / Emails links with an active state,
// plus the prominent "+ Create event" CTA. Client component only for
// usePathname — no data fetching here.

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/host', label: 'Dashboard', exact: true },
  { href: '/host/contacts', label: 'Contacts', exact: false },
  { href: '/host/emails', label: 'Emails', exact: false },
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
    <nav aria-label="Host portal" className="flex items-center gap-1">
      {LINKS.map((l) => {
        const active = isNavActive(pathname, l)
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm ${
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

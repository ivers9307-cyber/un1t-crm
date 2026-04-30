'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

// Three-tab layout: Active (new + pending), Completed (archived),
// Reports (cash/perf/operational metrics across the fleet).
// The merged Active view shows a status badge per row so the
// new/pending distinction is still visible at a glance.
const TABS = [
  { id: 'active',    label: 'Active',    href: '/cars/active'    },
  { id: 'completed', label: 'Completed', href: '/cars/completed' },
  { id: 'reports',   label: 'Reports',   href: '/cars/reports'   },
]

export default function CarTabs() {
  const pathname = usePathname()
  return (
    <div className="flex p-1 bg-un1t-dark border border-un1t-gray rounded-xl mb-6 max-w-xl">
      {TABS.map(t => {
        const active = pathname === t.href
        return (
          <Link
            key={t.id}
            href={t.href}
            className={clsx(
              'flex-1 text-center py-2 rounded-lg text-sm transition-colors',
              active
                ? 'bg-un1t-white text-un1t-black font-semibold'
                : 'text-un1t-light hover:text-un1t-white'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}

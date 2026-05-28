'use client'

// Top-of-page segmented control that matches the iOS app's Home-tab
// segmented control. Active segment is derived from the URL pathname,
// not local state — sub-routes are real Next pages so a refresh / share
// link works.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

export default function DashboardTabs({ segments }) {
  const pathname = usePathname()
  return (
    <div className="flex p-1 bg-un1t-surface border border-un1t-border rounded-xl mb-6 max-w-md">
      {segments.map(s => {
        const active = pathname === s.href
        return (
          <Link
            key={s.id}
            href={s.href}
            className={clsx(
              'flex-1 text-center py-2 rounded-lg text-sm transition-colors',
              active
                ? 'bg-un1t-text text-un1t-bg font-semibold'
                : 'text-un1t-subtle hover:text-un1t-text'
            )}
          >
            {s.label}
          </Link>
        )
      })}
    </div>
  )
}

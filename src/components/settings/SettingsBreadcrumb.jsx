'use client'

// SETTINGS.2g Task 2 — the single back-link style for every /settings/*
// sub-page, hoisted into the shared layout (src/app/settings/layout.js)
// so ~10 near-identical hand-rolled copies don't have to stay in sync by
// hand. Client component ONLY because layouts can't read the pathname
// server-side in Next's App Router (no useSearchParams/usePathname on a
// server component) — this is the smallest possible client boundary to
// get that one bit of state; everything else about /settings/layout.js
// stays a server component.
//
// Hides itself entirely on the index (/settings) — a "back to Settings"
// link on the Settings page itself would point at its own page.
//
// This is chrome for the TOP-LEVEL settings family only. Deeper pages
// (e.g. /settings/notifications/health, /settings/customer-agent/analytics,
// /settings/hosts/[id]) keep their OWN hand-rolled back-link pointing at
// their immediate parent — that's hierarchy navigation, not the repeated
// "back to the settings index" chrome this component replaces. See the
// Task 2 step 3 keep/remove list in the SETTINGS.2g commit message.

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

export default function SettingsBreadcrumb() {
  const pathname = usePathname()
  if (pathname === '/settings') return null

  return (
    <div className="print:hidden px-8 pt-4">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-xs text-un1t-subtle hover:text-un1t-text"
      >
        <ChevronLeft size={14} /> Settings
      </Link>
    </div>
  )
}

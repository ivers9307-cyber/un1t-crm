'use client'

// POLICIES.1 + POLICIES-VIEWS.1 — top-of-page banner shown when the
// user has at least one policy with a current version they have NOT
// yet opened (no completed view session). Modelled on
// PendingContractsAlert but without a modal — policy updates aren't
// as time-critical as unsigned contracts, so a soft banner with a
// call-to-action is right.
//
// Hidden on /policies and /policies/* (user is already there).
// Persists across navigation — there's no "dismiss" affordance,
// because the dismiss state would mask material HR updates and
// undermine the visibility value of the system. The way to make it
// go away is to open the policy (which records a view session).

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle } from 'lucide-react'

function shouldHideOn(pathname) {
  if (!pathname) return false
  return pathname.startsWith('/policies')
}

export default function UnreadPoliciesBanner() {
  const pathname = usePathname()
  const [count, setCount] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/policies')
      .then((r) => r.json())
      .then((json) => {
        if (!alive) return
        const list = json?.data || []
        const unread = list.filter((p) => p.current_version && !p.viewed_at).length
        setCount(unread)
        setLoaded(true)
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => { alive = false }
    // Re-run on pathname change so an acknowledgement on /policies/[slug]
    // takes effect immediately on the next nav.
  }, [pathname])

  if (!loaded) return null
  if (count === 0) return null
  if (shouldHideOn(pathname)) return null

  return (
    <div className="bg-blue-600 text-white px-4 py-2 text-xs flex items-center gap-3">
      <AlertCircle size={14} />
      <span className="flex-1 min-w-0 truncate">
        {count === 1
          ? 'You have a policy you haven\'t opened yet.'
          : `You have ${count} policies you haven\'t opened yet.`}
      </span>
      <Link
        href="/policies"
        className="bg-white text-blue-700 px-3 py-1 rounded-md font-semibold whitespace-nowrap hover:opacity-90"
      >
        Open
      </Link>
    </div>
  )
}

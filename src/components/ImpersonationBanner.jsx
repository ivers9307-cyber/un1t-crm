'use client'

// Persistent banner shown across the entire app whenever a master is
// impersonating another user. Bright + sticky so it's impossible to
// forget you're not "really" logged in as the user whose data you're
// looking at.

import { useState } from 'react'
import { UserCog, X } from 'lucide-react'

export default function ImpersonationBanner({ user }) {
  const [stopping, setStopping] = useState(false)
  const masterName = user?.impersonatingFrom?.masterName || 'Master'
  const targetName = user?.full_name || 'user'
  const targetRole = user?.role || ''

  async function stop() {
    setStopping(true)
    try {
      await fetch('/api/impersonate/stop', { method: 'POST' })
      // Hard reload so EVERY server component re-fetches getCurrentUser
      // without the cookie. router.refresh() alone leaves cached
      // RSC bundles in place and the banner sometimes lingers.
      window.location.assign('/')
    } catch {
      setStopping(false)
    }
  }

  return (
    <div className="bg-amber-500 text-un1t-black text-sm flex items-center justify-between gap-3 px-4 py-2 shrink-0 border-b border-amber-600">
      <div className="flex items-center gap-2 min-w-0">
        <UserCog size={16} className="shrink-0" />
        <span className="truncate">
          <strong>Viewing as {targetName}</strong>
          {targetRole && <span className="opacity-75"> · {targetRole}</span>}
          <span className="opacity-75"> — signed in as {masterName}</span>
        </span>
      </div>
      <button
        onClick={stop}
        disabled={stopping}
        className="flex items-center gap-1 text-xs font-semibold bg-un1t-black text-amber-400 px-3 py-1 rounded-md hover:bg-un1t-black/80 disabled:opacity-50"
      >
        <X size={12} /> {stopping ? 'Stopping…' : 'Stop impersonating'}
      </button>
    </div>
  )
}

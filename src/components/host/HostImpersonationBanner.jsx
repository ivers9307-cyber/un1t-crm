'use client'
import { useState } from 'react'

export default function HostImpersonationBanner({ hostName }) {
  const [exiting, setExiting] = useState(false)
  async function exit() {
    setExiting(true)
    try {
      await fetch('/api/hosts/impersonate/exit', { method: 'POST' })
    } finally {
      window.location.href = '/settings/hosts'
    }
  }
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-sm">
      <div className="max-w-4xl mx-auto px-4 h-10 flex items-center justify-between gap-3">
        <span>Viewing <strong>{hostName}</strong>&apos;s portal as admin.</span>
        <button type="button" onClick={exit} disabled={exiting} className="shrink-0 rounded-lg bg-white text-black text-xs font-semibold px-3 py-1.5 hover:bg-white/90 disabled:opacity-60">
          {exiting ? 'Exiting…' : 'Exit to CRM'}
        </button>
      </div>
    </div>
  )
}

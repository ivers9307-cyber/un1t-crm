'use client'
import { useState } from 'react'
import { HOST_BTN_PRIMARY_SM } from '@/components/host/host-ui'

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
    <div className="bg-host-warn-bg border-b border-host-warn-edge text-host-warn text-sm">
      <div className="max-w-4xl mx-auto px-4 h-10 flex items-center justify-between gap-3">
        <span>Viewing <strong>{hostName}</strong>&apos;s portal as admin.</span>
        <button type="button" onClick={exit} disabled={exiting} className={`shrink-0 ${HOST_BTN_PRIMARY_SM}`}>
          {exiting ? 'Exiting…' : 'Exit to CRM'}
        </button>
      </div>
    </div>
  )
}

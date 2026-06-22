'use client'
// InBodySyncButton — CONSULTATIONS SP2 Phase 2b
//
// Queues an on-demand InBody backfill for this contact. POSTs to
// /api/contacts/[id]/inbody-sync, which enqueues a request the on-site Pi
// drains (GetDateTimes → GetFullInBodyData → inbody_scans). Scans appear on the
// next page load once the Pi processes it (typically a minute or two).

import { useState } from 'react'
import { Button } from '@/components/ui'

export default function InBodySyncButton({ contactId }) {
  const [status, setStatus] = useState('idle') // idle | posting | queued | error
  const [message, setMessage] = useState('')

  async function onClick() {
    setStatus('posting')
    setMessage('')
    try {
      const res = await fetch(`/api/contacts/${contactId}/inbody-sync`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        setStatus('queued')
        setMessage('Sync requested — scans will appear here in a minute or two. Refresh the page to check.')
      } else {
        setStatus('error')
        setMessage(data.error || 'Could not queue the sync.')
      }
    } catch {
      setStatus('error')
      setMessage('Could not reach the server. Try again.')
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        variant="secondary"
        size="sm"
        onClick={onClick}
        disabled={status === 'posting' || status === 'queued'}
      >
        {status === 'posting' ? 'Requesting…' : status === 'queued' ? 'Sync requested' : 'Sync InBody history'}
      </Button>
      {message && (
        <p className={`text-sm ${status === 'error' ? 'text-red-700' : 'text-un1t-muted'}`}>{message}</p>
      )}
    </div>
  )
}

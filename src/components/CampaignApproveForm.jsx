'use client'

// MCPEMAIL.1 — the approve page's one button. It posts the approval once to
// the cookie-session route and shows the outcome inline. Every prop is a
// plain string (the page is a server component).

import { useRef, useState } from 'react'
import { Button } from '@/components/ui'

export default function CampaignApproveForm({ token, label, whenLabel = null }) {
  const [state, setState] = useState('idle') // idle | posting | done | error
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)

  async function approve() {
    if (inFlight.current || state === 'done') return
    inFlight.current = true
    setState('posting')
    setMessage('')
    try {
      const res = await fetch(`/api/communications/campaigns/approve/${encodeURIComponent(token)}`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      let body = null
      try { body = await res.json() } catch { /* a non-JSON answer: handled below */ }
      if (res.ok && body?.success) {
        const data = body.data || {}
        setState('done')
        setMessage(data.status === 'scheduled'
          ? `Scheduled for ${whenLabel || data.scheduled_at}. The final head count is taken when it sends.`
          : 'Queued. It starts sending within a minute or two; the final head count is taken when it sends.')
        return
      }
      setState('error')
      setMessage(body?.error || `This could not be approved (${res.status}). Try again.`)
    } catch {
      setState('error')
      setMessage('This could not be approved: the connection failed. Try again.')
    } finally {
      inFlight.current = false
    }
  }

  const disabled = state === 'posting' || state === 'done'
  return (
    <div className="space-y-3">
      <Button type="button" onClick={approve} disabled={disabled}>
        {state === 'posting' ? 'Approving…' : label}
      </Button>
      {state === 'done' && <p role="status" className="text-sm text-green-700">{message}</p>}
      {state === 'error' && <p role="alert" className="text-sm text-red-700">{message}</p>}
    </div>
  )
}

'use client'

// Posts a scanned check-in token to the scan endpoint on mount and shows the
// result. Reached when staff scan a per-attendee QR (EVENT-CHECKIN.B).

import { useEffect, useState } from 'react'
import { Check, X, Loader2 } from 'lucide-react'

export default function ScanCheckinClient({ eventId, token }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!token) {
        setState({ status: 'error', message: 'No check-in code in this link.' })
        return
      }
      try {
        const res = await fetch(`/api/events/${eventId}/checkin/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || json.success === false) {
          setState({ status: 'error', message: json.error || 'Check-in failed.' })
        } else {
          setState({ status: 'ok', name: json.data?.name || 'Attendee' })
        }
      } catch {
        if (!cancelled) setState({ status: 'error', message: 'Network error — try again.' })
      }
    }
    run()
    return () => { cancelled = true }
  }, [eventId, token])

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-un1t-subtle">
        <Loader2 className="animate-spin" /> Checking in…
      </div>
    )
  }
  if (state.status === 'ok') {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500 text-white">
          <Check size={32} />
        </span>
        <div className="text-lg font-semibold text-un1t-text">Checked in</div>
        <div className="text-un1t-subtle">{state.name}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500 text-white">
        <X size={32} />
      </span>
      <div className="text-lg font-semibold text-un1t-text">Couldn’t check in</div>
      <div className="text-un1t-subtle text-sm">{state.message}</div>
    </div>
  )
}

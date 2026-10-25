'use client'

// BOOKINGOUTCOME.1 — one-tap outcome on a row of /bookings?filter=needs_outcome.
// Showed → completed, No-show → no_show, through the same route as the status
// pill (POST /api/bookings/[id]/status: the web `bookings` key at the
// booking's studio, a compare-and-swap on the status). On success the page
// refreshes and the row leaves the list; a refusal shows the route's words.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const FAILED = 'Could not save the outcome. Try again.'

export async function postBookingStatus(bookingId, status, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`/api/bookings/${bookingId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.success) return { ok: false, error: data?.error || FAILED }
    return { ok: true }
  } catch {
    return { ok: false, error: FAILED }
  }
}

export default function BookingOutcomeButtons({ bookingId }) {
  const [busy, setBusy] = useState(null) // the status being saved
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)
  const router = useRouter()

  async function record(status) {
    setBusy(status)
    setError(null)
    const result = await postBookingStatus(bookingId, status)
    setBusy(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDone(status)
    router.refresh()
  }

  if (done) {
    return (
      <span className="text-xs text-un1t-subtle">
        {done === 'completed' ? 'Marked as showed' : 'Marked as no-show'}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => record('completed')}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-full bg-green-500/10 text-green-700 hover:bg-green-500/20 disabled:opacity-50 transition-colors"
        >
          {busy === 'completed' ? 'Saving…' : 'Showed'}
        </button>
        <button
          type="button"
          onClick={() => record('no_show')}
          disabled={busy !== null}
          className="text-xs px-3 py-1.5 rounded-full bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
        >
          {busy === 'no_show' ? 'Saving…' : 'No-show'}
        </button>
      </div>
      {error && <p role="alert" className="text-[11px] text-red-700">{error}</p>}
    </div>
  )
}

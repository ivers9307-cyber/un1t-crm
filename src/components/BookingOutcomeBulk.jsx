'use client'

// BOOKINGOUTCOME.1 — "Mark all as showed" on /bookings?filter=needs_outcome.
// Asks first, then sends the listed ids to POST /api/bookings/outcomes in
// batches of 200 (the route's limit). The route judges every booking again
// (permission, still confirmed, ended), so a booking that changed since the
// page loaded is skipped, never overwritten; the result says how many.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal } from '@/components/ui'

export const OUTCOME_BATCH = 200
const FAILED = 'Could not save the outcomes. Try again.'

/**
 * Send every id in batches. Stops at the first batch that fails and reports
 * what the earlier batches saved.
 * @returns {Promise<{ updated: number, skipped: number, error: string|null }>}
 */
export async function markAllOutcomes(ids, status, fetchImpl = fetch) {
  const out = { updated: 0, skipped: 0, error: null }
  for (let i = 0; i < ids.length; i += OUTCOME_BATCH) {
    const batch = ids.slice(i, i + OUTCOME_BATCH)
    try {
      const res = await fetchImpl('/api/bookings/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_ids: batch, status }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        out.error = data?.error || FAILED
        return out
      }
      out.updated += data.data?.updated?.length || 0
      out.skipped += data.data?.skipped?.length || 0
    } catch {
      out.error = FAILED
      return out
    }
  }
  return out
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export default function BookingOutcomeBulk({ bookingIds }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const router = useRouter()
  const count = bookingIds?.length || 0
  if (!count) return null

  async function apply() {
    setBusy(true)
    const r = await markAllOutcomes(bookingIds, 'completed')
    setBusy(false)
    setConfirming(false)
    setResult(r)
    if (r.updated) router.refresh()
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="secondary" onClick={() => { setResult(null); setConfirming(true) }}>
        Mark all as showed
      </Button>
      {result && (
        <p role={result.error ? 'alert' : 'status'} className={`text-xs ${result.error ? 'text-red-700' : 'text-un1t-subtle'}`}>
          {result.updated > 0 && `Marked ${plural(result.updated, 'booking', 'bookings')} as showed. `}
          {result.skipped > 0 && `${plural(result.skipped, 'booking was', 'bookings were')} skipped (changed or not yours to edit). `}
          {result.error}
        </p>
      )}
      <Modal
        open={confirming}
        onClose={() => { if (!busy) setConfirming(false) }}
        title="Mark all as showed?"
        size="sm"
        footer={(
          <>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
            <Button type="button" onClick={apply} loading={busy}>
              Mark {plural(count, 'booking', 'bookings')} as showed
            </Button>
          </>
        )}
      >
        <p className="text-sm text-un1t-subtle">
          This records that all {plural(count, 'booker', 'bookers')} on this list turned up. Mark any no-shows first.
        </p>
      </Modal>
    </div>
  )
}

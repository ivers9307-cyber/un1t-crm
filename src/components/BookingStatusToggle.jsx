'use client'

// Booking status pill on /bookings. Three flows:
//
//   confirmed → completed   straight DB write (low-stakes; the
//                           customer turned up)
//   confirmed → no_show     same — operator marking a no-show
//   confirmed → cancelled   goes through POST /api/bookings/[id]/cancel
//                           with a confirm dialog + optional
//                           customer email. Cancel is the one
//                           transition with side effects (notify),
//                           so it gets the API path. Tier 2.
//
// Status pill colours use the un1t light-theme ramp: -700 text on
// /20 tinted background reads cleanly without washing out.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

const statusColors = {
  confirmed: 'bg-blue-500/20 text-blue-700',
  completed: 'bg-green-500/20 text-green-700',
  cancelled: 'bg-red-500/20 text-red-700',
  no_show:   'bg-yellow-500/20 text-yellow-700',
}

const statusOptions = ['confirmed', 'completed', 'cancelled', 'no_show']

export default function BookingStatusToggle({ bookingId, currentStatus }) {
  const [status, setStatus] = useState(currentStatus)
  const [open, setOpen] = useState(false)
  const [cancelModal, setCancelModal] = useState(false)
  const router = useRouter()

  async function setNonCancelStatus(newStatus) {
    setStatus(newStatus)
    setOpen(false)
    const db = createBrowserClient()
    await db.from('bookings').update({ status: newStatus }).eq('id', bookingId)
    router.refresh()
  }

  function handlePick(newStatus) {
    setOpen(false)
    if (newStatus === 'cancelled' && status !== 'cancelled') {
      setCancelModal(true)
      return
    }
    setNonCancelStatus(newStatus)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`text-xs px-2.5 py-1 rounded-full ${statusColors[status] || statusColors.confirmed}`}
      >
        {status.replace('_', ' ')}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-un1t-dark border border-un1t-gray rounded-lg shadow-lg z-10 py-1 min-w-[120px]">
          {statusOptions.map(opt => (
            <button
              key={opt}
              onClick={() => handlePick(opt)}
              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-un1t-gray/50 transition-colors ${
                opt === status ? 'text-un1t-white' : 'text-un1t-light'
              }`}
            >
              {opt.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}

      {cancelModal && (
        <CancelBookingModal
          bookingId={bookingId}
          onClose={() => setCancelModal(false)}
          onCancelled={() => {
            setStatus('cancelled')
            setCancelModal(false)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function CancelBookingModal({ bookingId, onClose, onCancelled }) {
  const [notify, setNotify] = useState(true)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleCancel() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify_customer: notify, reason: reason.trim() || null }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Cancellation failed')
        setBusy(false)
        return
      }
      onCancelled()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-un1t-dark border border-un1t-gray rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold mb-1">Cancel this booking?</h3>
        <p className="text-xs text-un1t-light mb-4">
          The customer&apos;s slot will be released. This is one-way — re-booking requires a new reservation.
        </p>

        <label className="flex items-start gap-2 text-sm mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={notify}
            onChange={e => setNotify(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Email the customer that their booking has been cancelled.
            <span className="block text-[11px] text-un1t-light mt-0.5">
              Skipped automatically if they&apos;ve opted out of administrative emails.
            </span>
          </span>
        </label>

        {notify && (
          <div className="mb-4">
            <label className="block text-xs text-un1t-light mb-1">Reason (optional, included in the email)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Class is full / Coach unavailable"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white resize-none"
            />
          </div>
        )}

        {error && (
          <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/40 rounded p-2 mb-3">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-2 rounded-md text-sm border border-un1t-gray text-un1t-light hover:text-un1t-white hover:border-un1t-white/30"
          >
            Keep booking
          </button>
          <button
            onClick={handleCancel}
            disabled={busy}
            className="px-3 py-2 rounded-md text-sm font-medium bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
          >
            {busy ? 'Cancelling…' : 'Cancel booking'}
          </button>
        </div>
      </div>
    </div>
  )
}

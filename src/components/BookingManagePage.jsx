'use client'

// BookingManagePage — the person who booked cancels or reschedules their own
// booking (BOOKINGSELF.1). Reached from the {{manage_url}} link in the
// booking confirmation and reminder emails: /book/manage/[token]. The token
// is the only credential; every request carries it in the path.
//
// What it shows: the booking (type, studio, date and time as stored in the
// studio's zone), then either why it can no longer be changed online, or
// two actions: Reschedule (pick a day, then a free time of the same booking
// type; the server re-checks the slot) and Cancel (confirm first). Refusals
// show the server's own sentence. Times only: never a count of anything.
//
// Copy is neutral UI wording, kept minimal (no em dashes, no emoji): the
// business message is the operator's confirmation email, which a
// reschedule sends again.
//
// Styling follows BookingWidget (the light public booking page).

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, Check, Clock, MapPin } from 'lucide-react'

async function readJson(res) {
  try { return await res.json() } catch { return null }
}

const STATUS_LABEL = {
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'Missed',
}

export default function BookingManagePage({ token }) {
  const base = `/api/public/booking-manage/${encodeURIComponent(token || '')}`
  const [booking, setBooking] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [mode, setMode] = useState('view') // view | reschedule | cancel
  const [day, setDay] = useState(null)
  const [slots, setSlots] = useState(null)
  const [slotsError, setSlotsError] = useState(null)
  const [slot, setSlot] = useState(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' })
      const j = await readJson(res)
      if (!res.ok || !j?.success) {
        setLoadError(j?.message || 'This page could not be loaded. Please try again.')
        return
      }
      setBooking(j.data)
    } catch {
      setLoadError('This page could not be loaded. Check your connection and try again.')
    }
  }, [base])

  useEffect(() => { load() }, [load])

  function resetPicker() {
    setDay(null); setSlots(null); setSlotsError(null); setSlot(null); setActionError(null)
  }

  async function pickDay(d) {
    setDay(d); setSlot(null); setSlots(null); setSlotsError(null); setActionError(null)
    try {
      const res = await fetch(`${base}/slots?date=${encodeURIComponent(d.date)}`, { cache: 'no-store' })
      const j = await readJson(res)
      if (!res.ok || !j?.success) {
        setSlotsError(j?.message || 'The times could not be loaded. Please try again.')
        setSlots([])
        return
      }
      setSlots(j.data.slots || [])
    } catch {
      setSlotsError('The times could not be loaded. Check your connection and try again.')
      setSlots([])
    }
  }

  async function submit(path, body) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const j = await readJson(res)
      if (!res.ok || !j?.success) {
        setActionError(j?.message || 'Your change could not be saved. Please try again.')
        return false
      }
      return true
    } catch {
      setActionError('Your change could not be saved. Check your connection and try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function confirmReschedule() {
    if (!day || !slot) return
    if (await submit('reschedule', { booking_date: day.date, start_time: slot.start })) {
      setMode('view'); resetPicker()
      setNotice('Your booking has been moved.')
      await load()
    }
  }

  async function confirmCancel() {
    if (await submit('cancel')) {
      setMode('view')
      setNotice('Your booking has been cancelled.')
      await load()
    }
  }

  if (loadError) {
    return (
      <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
        <AlertCircle size={28} className="mx-auto text-red-500 mb-3" />
        <p className="text-sm text-gray-700">{loadError}</p>
      </div>
    )
  }

  if (!booking) {
    return (
      <div className="w-full max-w-md p-8 text-center" aria-busy="true">
        <div className="animate-spin w-5 h-5 border-2 border-gray-200 border-t-gray-700 rounded-full mx-auto" />
      </div>
    )
  }

  const cancelled = booking.status === 'cancelled'

  return (
    <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="p-6 border-b border-gray-100">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-xl font-bold text-gray-900 leading-snug">{booking.event_name}</h1>
          <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${cancelled ? 'bg-red-500/10 text-red-700' : 'bg-green-500/10 text-green-700'}`}>
            {STATUS_LABEL[booking.status] || booking.status}
          </span>
        </div>
        <div className="mt-3 space-y-1.5 text-sm text-gray-600">
          <p className={`flex items-center gap-2 ${cancelled ? 'line-through' : ''}`}>
            <CalendarClock size={14} className="text-gray-400" /> {booking.when_label}
          </p>
          {booking.duration_minutes ? (
            <p className="flex items-center gap-2"><Clock size={14} className="text-gray-400" /> {booking.duration_minutes} min</p>
          ) : null}
          {booking.studio_name ? (
            <p className="flex items-start gap-2">
              <MapPin size={14} className="text-gray-400 mt-0.5" />
              <span>{booking.studio_name}{booking.studio_address ? `, ${booking.studio_address}` : ''}</span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="p-6 space-y-4">
        {notice ? (
          <p className="flex items-center gap-2 text-sm text-green-700 bg-green-500/10 rounded-md px-3 py-2">
            <Check size={14} /> {notice}
          </p>
        ) : null}

        {booking.blocked_reason && !cancelled ? (
          <p className="text-sm text-gray-700">{booking.blocked_reason}</p>
        ) : null}

        {mode === 'view' && (booking.can_cancel || booking.can_reschedule) ? (
          <div className="space-y-2">
            {booking.can_reschedule ? (
              <button type="button" onClick={() => { setNotice(null); resetPicker(); setMode('reschedule') }}
                className="w-full py-2 rounded-md bg-gray-900 text-white text-sm font-medium hover:bg-gray-800">
                Reschedule
              </button>
            ) : null}
            {booking.reschedule_note ? <p className="text-sm text-gray-600">{booking.reschedule_note}</p> : null}
            {booking.can_cancel ? (
              <button type="button" onClick={() => { setNotice(null); setActionError(null); setMode('cancel') }}
                className="w-full py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
                Cancel booking
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === 'cancel' ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-800">Cancel this booking?</p>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={confirmCancel}
                className="flex-1 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60">
                {busy ? 'Cancelling...' : 'Yes, cancel'}
              </button>
              <button type="button" disabled={busy} onClick={() => { setActionError(null); setMode('view') }}
                className="flex-1 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
                Keep it
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'reschedule' ? (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-900 mb-2">Pick a day</p>
              {booking.available_days == null ? (
                <p className="text-sm text-gray-600">The dates could not be loaded. Please reload the page.</p>
              ) : booking.available_days.length === 0 ? (
                <p className="text-sm text-gray-600">No other times are free right now.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {booking.available_days.map((d) => (
                    <button key={d.date} type="button" onClick={() => pickDay(d)}
                      className={`px-3 py-1.5 rounded-md border text-sm ${day?.date === d.date ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {day ? (
              <div>
                <p className="text-sm font-medium text-gray-900 mb-2">Pick a time</p>
                {slots == null ? (
                  <div className="animate-spin w-4 h-4 border-2 border-gray-200 border-t-gray-700 rounded-full" />
                ) : slotsError ? (
                  <p className="text-sm text-red-700">{slotsError}</p>
                ) : slots.length === 0 ? (
                  <p className="text-sm text-gray-600">No free times on this day.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {slots.map((s) => (
                      <button key={s.start} type="button" onClick={() => { setSlot(s); setActionError(null) }}
                        className={`py-1.5 rounded-md border text-sm ${slot?.start === s.start ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                        {s.start}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex gap-2">
              <button type="button" disabled={busy || !slot} onClick={confirmReschedule}
                className="flex-1 py-2 rounded-md bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-50">
                {busy ? 'Saving...' : slot ? `Move to ${day.label}, ${slot.start}` : 'Move booking'}
              </button>
              <button type="button" disabled={busy} onClick={() => { resetPicker(); setMode('view') }}
                className="flex-1 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
                Back
              </button>
            </div>
          </div>
        ) : null}

        {actionError ? (
          <p className="flex items-start gap-2 text-sm text-red-700"><AlertCircle size={14} className="mt-0.5 shrink-0" /> {actionError}</p>
        ) : null}

        {booking.timezone ? (
          <p className="text-xs text-gray-500">Times are local to the studio ({booking.timezone}).</p>
        ) : null}
      </div>
    </div>
  )
}

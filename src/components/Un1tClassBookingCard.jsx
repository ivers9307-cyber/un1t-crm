'use client'

// UN1TWRITE.15 — book a contact into a un1t.online class from the contact
// page, one card per un1t.online studio where they hold an account (the page
// decides which, through un1tBookingStudios). The class list, booking and
// Undo are the shared BookPanel with classProvider 'un1t_online'; this card
// adds the credits line and the person's upcoming bookings at the studio,
// each with Cancel. Everything goes through /api/un1t-online/classes*, gated
// on the BOOKING studio.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarPlus } from 'lucide-react'
import BookPanel from '@/components/BookPanel'

function creditsText(credits) {
  if (!credits) return null
  if (credits.unlimited) return 'Unlimited'
  if (Number.isFinite(credits.balance) && credits.balance > 0) return `Credits: ${credits.balance}`
  if (credits.balance === 0) return 'No credits: un1t.online will refuse unless they hold a membership'
  return null
}

function fmtWhen(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function Un1tClassBookingCard({ contactId, locationId, studioName, waConversationId, waWindowOpen }) {
  const router = useRouter()
  const [info, setInfo] = useState(null) // { credits, upcoming } from the class list
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState(null) // booking id being cancelled
  const [note, setNote] = useState(null)
  const canWhatsApp = !!waConversationId && !!waWindowOpen

  const reload = () => {
    setReloadKey((k) => k + 1)
    router.refresh()
  }

  async function cancelBooking(bookingId) {
    if (busy) return
    setBusy(bookingId)
    setNote(null)
    try {
      const res = await fetch('/api/un1t-online/classes/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, location_id: locationId, booking_id: bookingId }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.success) {
        setNote({ ok: true, message: 'Booking cancelled in un1t.online.' })
        reload()
      } else {
        setNote({ ok: false, message: data.error || 'Cancel failed' })
      }
    } finally {
      setBusy(null)
    }
  }

  const credits = creditsText(info?.credits)
  const asOf = info?.credits?.as_of ? fmtWhen(info.credits.as_of) : null
  const upcoming = info?.upcoming || []

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
        <CalendarPlus size={12} /> Book a class at {studioName}
      </h3>
      {credits && (
        <p className="text-xs text-un1t-text mb-3">
          {credits}
          {asOf ? <span className="text-un1t-muted"> (as of {asOf})</span> : null}
        </p>
      )}
      <BookPanel
        key={reloadKey}
        contactId={contactId}
        locationId={locationId}
        eventTypes={[]}
        classProvider="un1t_online"
        onClassesLoaded={setInfo}
        channel={canWhatsApp ? 'wa' : null}
        conversationId={canWhatsApp ? waConversationId : null}
        notifyLabel="Also send a WhatsApp confirmation"
        onBooked={reload}
      />
      {upcoming.length > 0 && (
        <div className="mt-4 pt-3 border-t border-un1t-border">
          <p className="text-[11px] font-semibold text-un1t-subtle mb-2">Upcoming at {studioName}</p>
          <ul className="space-y-1.5">
            {upcoming.map((b) => (
              <li key={b.booking_id} className="flex items-center justify-between gap-2 border border-un1t-border rounded-lg px-2.5 py-1.5">
                <span className="text-xs min-w-0 truncate">{b.name} · {fmtWhen(b.starts_at)}</span>
                <button
                  type="button"
                  onClick={() => cancelBooking(b.booking_id)}
                  disabled={busy !== null}
                  className="shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-red-500/30 text-red-700 hover:bg-red-500/10 disabled:opacity-50"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note && <p className={`text-xs mt-2 ${note.ok ? 'text-emerald-700' : 'text-red-700'}`}>{note.message}</p>}
    </div>
  )
}

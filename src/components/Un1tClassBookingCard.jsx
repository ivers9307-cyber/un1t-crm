'use client'

// UN1TWRITE.15 — book a contact into a un1t.online class from the contact
// page, one card per un1t.online studio where they hold an account (the page
// decides which, through un1tBookingStudios). The class list, booking and
// Undo are the shared BookPanel with classProvider 'un1t_online'; this card
// adds the credits line and the person's upcoming bookings at the studio,
// each with Cancel and (UN1TMOVE.1) Move, which moves the booking to another
// class in one un1t.online call rather than a cancel then a book. Everything
// goes through /api/un1t-online/classes*, gated on the BOOKING studio.
// UN1TMOVE.2 — a done move drops the studio's editable "your booking was
// moved" text (class_move_confirmation_text, handed back as chat_template)
// into the open WhatsApp thread when the confirmation is ticked, exactly as
// BookPanel does for a booking: best effort, it never undoes the move.

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarPlus } from 'lucide-react'
import BookPanel from '@/components/BookPanel'
import { UN1T_STAFF_COPY } from '@/lib/un1t-staff-booking-copy'
import { moveChatConfirmationText } from '@/lib/book-chat-copy'

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
  const [busy, setBusy] = useState(null) // booking id being cancelled or moved
  const [note, setNote] = useState(null)
  const [moving, setMoving] = useState(null) // { bookingId, eventId: the chosen class or '' }
  const [notifyMove, setNotifyMove] = useState(true)
  const canWhatsApp = !!waConversationId && !!waWindowOpen

  // After a booking or a cancel: re-read the credits and the upcoming list
  // only. The panel is never remounted, so its result line and Undo stay.
  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/un1t-online/classes?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`)
      const data = await res.json().catch(() => ({}))
      if (data.success) setInfo(data.data)
    } catch { /* the list stays as it was */ }
    router.refresh()
  }, [contactId, locationId, router])

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

  // The moved text into the open WhatsApp thread: a status note, never a throw.
  async function sendMovedText(text) {
    if (!canWhatsApp || !notifyMove) return ''
    try {
      const res = await fetch(`/api/whatsapp/conversations/${waConversationId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      return data.success ? ' Message sent in the chat.' : ` The chat message did not send (${data.error || 'window closed'}).`
    } catch {
      return ' The chat message did not send.'
    }
  }

  async function moveBooking() {
    if (busy || !moving?.eventId) return
    const { bookingId, eventId } = moving
    const leaving = (info?.upcoming || []).find((u) => u.booking_id === bookingId)
    const target = (info?.classes || []).find((c) => c.id === eventId)
    setBusy(bookingId)
    setNote(null)
    try {
      const res = await fetch('/api/un1t-online/classes/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, location_id: locationId, booking_id: bookingId, event_id: eventId }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.success) {
        const text = moveChatConfirmationText({
          from: leaving ? [leaving.name, fmtWhen(leaving.starts_at)].filter(Boolean).join(', ') : '',
          to: target ? [target.name, [target.day, target.time].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '',
          template: data.data?.chat_template,
        })
        const threadNote = await sendMovedText(text)
        setNote({ ok: true, message: `${UN1T_STAFF_COPY.moved}${threadNote}` })
        setMoving(null)
        reload()
      } else {
        setNote({ ok: false, message: data.error || 'Move failed' })
      }
    } finally {
      setBusy(null)
    }
  }

  const credits = creditsText(info?.credits)
  const classes = info?.classes || []
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
            {upcoming.map((b) => {
              const open = moving?.bookingId === b.booking_id
              const targets = classes.filter((c) => c.id !== b.event_id)
              return (
                <li key={b.booking_id} className="border border-un1t-border rounded-lg px-2.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs min-w-0 truncate">{b.name} · {fmtWhen(b.starts_at)}</span>
                    <span className="shrink-0 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMoving(open ? null : { bookingId: b.booking_id, eventId: '' })}
                        disabled={busy !== null || targets.length === 0}
                        className="text-[11px] px-2.5 py-1 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-bg disabled:opacity-50"
                      >
                        Move
                      </button>
                      <button
                        type="button"
                        onClick={() => cancelBooking(b.booking_id)}
                        disabled={busy !== null}
                        className="text-[11px] px-2.5 py-1 rounded-md border border-red-500/30 text-red-700 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                  {open && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <select
                        aria-label={`Move ${b.name} to`}
                        value={moving.eventId}
                        onChange={(e) => setMoving({ bookingId: b.booking_id, eventId: e.target.value })}
                        disabled={busy !== null}
                        className="min-w-0 flex-1 text-xs bg-un1t-surface border border-un1t-border rounded-md px-2 py-1"
                      >
                        <option value="">Choose a class…</option>
                        {targets.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} · {c.day} {c.time}{c.spots_left === 0 ? ' (full)' : ''}
                          </option>
                        ))}
                      </select>
                      {canWhatsApp && (
                        <label className="w-full flex items-center gap-2 text-[11px] text-un1t-subtle">
                          <input type="checkbox" checked={notifyMove} onChange={(e) => setNotifyMove(e.target.checked)} className="rounded border-un1t-border" />
                          Also send a WhatsApp message about the move
                        </label>
                      )}
                      <button
                        type="button"
                        onClick={moveBooking}
                        disabled={busy !== null || !moving.eventId}
                        className="text-[11px] px-2.5 py-1 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-bg disabled:opacity-50"
                      >
                        Move here
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {note && <p className={`text-xs mt-2 ${note.ok ? 'text-emerald-700' : 'text-red-700'}`}>{note.message}</p>}
    </div>
  )
}

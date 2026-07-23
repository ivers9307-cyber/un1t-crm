'use client'

// BOOK-PANEL (UIX-P3) — shared staff booking panel: consultations against
// the availability engine + Glofox class booking, with an optional
// confirmation drop into an open WhatsApp/Instagram thread. Extracted from
// CommandCentre (BOOK-ON-PROFILE.1) so the contact profile page reuses the
// exact same UI. `notifyLabel` lets the host relabel the confirm toggle for
// its context (inbox chat vs profile WhatsApp).
import { useState, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

function fmtDay(d) {
  return d.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
}

function fmtSlot(time) {
  const [h, m] = time.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

// Format a YYYY-MM-DD + HH:MM as Dublin wall-clock copy — no Date
// composition with Z suffixes (the BOOKING.2 lesson).
function fmtBookingLine(eventName, dateStr, time) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const label = new Date(Date.UTC(y, mo - 1, d, 12)).toLocaleDateString('en-IE', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
  return `✅ Booked: ${eventName} — ${label} at ${fmtSlot(time)}`
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function fmtClassTime(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
    + ' ' + new Date(ms).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })
}

function fmtClockTime(ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })
}

// Group an already-time-sorted class list into per-day sections with
// friendly headers (Today / Tomorrow / "Sat 13 Jun").
function groupClassesByDay(classes) {
  const dayLabel = (ms) => {
    if (!ms) return 'Unscheduled'
    const d = new Date(ms)
    const today = new Date()
    const tomorrow = new Date()
    tomorrow.setDate(today.getDate() + 1)
    const same = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    if (same(d, today)) return 'Today'
    if (same(d, tomorrow)) return 'Tomorrow'
    return d.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  const groups = []
  for (const cls of classes) {
    const label = dayLabel(cls.time_start_ms)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(cls)
    else groups.push({ label, items: [cls] })
  }
  return groups
}

function BookPanel({ contactId, locationId, glofoxMemberId, eventTypes, channel, conversationId, onBooked, notifyLabel = 'Send confirmation in the chat' }) {
  const [eventId, setEventId] = useState('')
  const [dateStr, setDateStr] = useState(null)
  const [slots, setSlots] = useState(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [booking, setBooking] = useState(false)
  const [result, setResult] = useState(null)
  const [dropInThread, setDropInThread] = useState(true)

  // Glofox classes (UIX-P3b) — fetched once when the Book tab opens.
  const [classes, setClasses] = useState(null)
  const [classesError, setClassesError] = useState(null)
  const [classResult, setClassResult] = useState(null)
  // Collapsible day groups — null means the default (only the first
  // day open); after the first toggle the Set is authoritative.
  const [openDays, setOpenDays] = useState(null)

  useEffect(() => {
    let cancelled = false
    const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
    fetch(`/api/glofox/classes${qs}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d.success) setClasses(d.configured === false ? [] : d.classes || [])
        else { setClasses([]); setClassesError(d.error || 'Could not load classes') }
      }, () => { if (!cancelled) { setClasses([]); setClassesError('Could not load classes') } })
    return () => { cancelled = true }
  }, [locationId])

  const event = eventTypes.find(e => e.id === eventId) || null

  // Next 14 days, filtered to the event's available weekdays.
  const days = []
  if (event) {
    for (let i = 0; i < 14; i++) {
      const d = new Date()
      d.setDate(d.getDate() + i)
      if (event.availability?.[DAY_KEYS[d.getDay()]]) {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        days.push({ d, ds })
      }
    }
  }

  useEffect(() => {
    setSlots(null)
    setResult(null)
    if (!event?.slug || !dateStr) return
    let cancelled = false
    setSlotsLoading(true)
    fetch(`/api/public/bookings/${event.slug}/slots?date=${dateStr}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setSlots(d.success ? d.data?.slots || [] : []) },
            () => { if (!cancelled) setSlots([]) })
      .finally(() => { if (!cancelled) setSlotsLoading(false) })
    return () => { cancelled = true }
  }, [event?.slug, dateStr])

  // Best-effort drop into the open WA/IG thread. Returns a status
  // note for the result line; a closed WA window reports the skip
  // rather than failing the booking.
  async function sendThreadText(text) {
    if (!dropInThread || !channel || !conversationId) return null
    // EMAIL-INBOX.1 — no chat drop-in for email threads: the booking's
    // own confirmation email/SMS covers the customer, and a one-line
    // chat blurb as a standalone email would read oddly.
    if (channel === 'em') return null
    const sendUrl = channel === 'ig'
      ? `/api/instagram/conversations/${conversationId}/send`
      : `/api/whatsapp/conversations/${conversationId}/send`
    try {
      const sendRes = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const sendData = await sendRes.json().catch(() => ({}))
      return sendData.success
        ? 'Confirmation sent in the chat.'
        : `Booked, but the chat message didn't send (${sendData.error || 'window closed — templates only'}).`
    } catch {
      return 'Booked, but the chat message didn\'t send.'
    }
  }

  async function book(time) {
    if (booking) return
    setBooking(true)
    setResult(null)
    try {
      const res = await fetch('/api/bookings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type_id: eventId,
          contact_id: contactId,
          booking_date: dateStr,
          start_time: time,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) {
        setResult({ ok: false, message: data.error || 'Booking failed' })
        return
      }

      const threadNote = await sendThreadText(fmtBookingLine(event.name, dateStr, time))
      const channels = data.confirmation?.channels_sent?.length
        ? ` Confirmation ${data.confirmation.channels_sent.join(' + ')} sent.`
        : ''
      setResult({ ok: true, message: `Booked for ${fmtSlot(time)}.${channels}${threadNote ? ` ${threadNote}` : ''}` })
      setSlots(null)
      setDateStr(null)
      onBooked?.()
    } finally {
      setBooking(false)
    }
  }

  // UIX-P3b — book the linked Glofox member into a class. Glofox
  // enforces capacity/double-booking; its message_code comes back
  // verbatim. A successful booking keeps the returned booking id so
  // the operator gets a one-click Undo (also the E2E cancel leg).
  async function bookClass(cls) {
    if (booking) return
    setBooking(true)
    setClassResult(null)
    try {
      const res = await fetch('/api/glofox/classes/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, event_id: cls.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) {
        setClassResult({ ok: false, message: data.error || 'Glofox booking failed' })
        return
      }
      const threadNote = await sendThreadText(
        `✅ Booked into ${cls.name}${cls.time_start_ms ? ` — ${fmtClassTime(cls.time_start_ms)}` : ''}`
      )
      setClassResult({
        ok: true,
        message: `Booked into ${cls.name}.${threadNote ? ` ${threadNote}` : ''}`,
        bookingId: data.glofox_booking_id || null,
      })
      onBooked?.()
    } finally {
      setBooking(false)
    }
  }

  async function undoClassBooking(bookingId) {
    if (booking || !bookingId) return
    setBooking(true)
    try {
      const res = await fetch('/api/glofox/classes/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, booking_id: bookingId }),
      })
      const data = await res.json().catch(() => ({}))
      setClassResult(data.success
        ? { ok: true, message: 'Booking cancelled in Glofox.' }
        : { ok: false, message: data.error || 'Cancel failed' })
    } finally {
      setBooking(false)
    }
  }

  if (eventTypes.length === 0) {
    return (
      <p className="text-xs text-un1t-subtle text-center py-6">
        No active bookable events at this studio yet.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <select
        value={eventId}
        onChange={e => { setEventId(e.target.value); setDateStr(null); setResult(null) }}
        className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:border-un1t-muted"
      >
        <option value="">Choose a session type…</option>
        {eventTypes.map(et => (
          <option key={et.id} value={et.id}>{et.name} ({et.duration_minutes}m)</option>
        ))}
      </select>

      {event && (
        <div className="flex flex-wrap gap-1.5">
          {days.length === 0 && (
            <p className="text-xs text-un1t-subtle">No available days in the next two weeks.</p>
          )}
          {days.map(({ d, ds }) => (
            <button
              key={ds}
              onClick={() => setDateStr(ds)}
              className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                dateStr === ds
                  ? 'bg-un1t-text text-un1t-bg border-transparent'
                  : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {fmtDay(d)}
            </button>
          ))}
        </div>
      )}

      {dateStr && (
        slotsLoading ? (
          <p className="text-xs text-un1t-subtle">Loading slots…</p>
        ) : slots && slots.length === 0 ? (
          <p className="text-xs text-un1t-subtle">No free slots that day.</p>
        ) : slots && (
          <div className="grid grid-cols-3 gap-1.5">
            {slots.map(s => (
              <button
                key={s.start}
                disabled={booking}
                onClick={() => book(s.start)}
                className="text-[11px] px-2 py-1.5 rounded-md border border-un1t-border text-un1t-text hover:bg-green-600 hover:text-white hover:border-transparent transition-colors disabled:opacity-50"
              >
                {fmtSlot(s.start)}
              </button>
            ))}
          </div>
        )
      )}

      {result && (
        <p className={`text-xs ${result.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {result.message}
        </p>
      )}

      {/* ── Glofox classes (UIX-P3b) — grouped by day ── */}
      <div className="pt-3 border-t border-un1t-border">
        <p className="text-[11px] font-semibold text-un1t-subtle mb-2">Glofox classes — next 7 days</p>

        {classes === null && <p className="text-xs text-un1t-subtle">Loading classes…</p>}
        {classesError && <p className="text-xs text-red-700">{classesError}</p>}
        {classes && classes.length === 0 && !classesError && (
          <p className="text-xs text-un1t-subtle">No upcoming classes found.</p>
        )}

        {!glofoxMemberId && classes && classes.length > 0 && (
          <p className="text-xs text-amber-700 mb-2">
            Not linked to a Glofox member — booking is disabled for this contact.
          </p>
        )}

        {classes && classes.length > 0 && (
          <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
            {groupClassesByDay(classes).map((group, idx) => {
              const isOpen = openDays ? openDays.has(group.label) : idx === 0
              const toggle = () => {
                const groups = groupClassesByDay(classes)
                const next = new Set(
                  openDays ?? groups.filter((g, i) => i === 0).map(g => g.label)
                )
                if (next.has(group.label)) next.delete(group.label)
                else next.add(group.label)
                setOpenDays(next)
              }
              return (
                <div key={group.label}>
                  <button
                    type="button"
                    onClick={toggle}
                    className="w-full flex items-center justify-between gap-2 bg-un1t-surface border border-un1t-border rounded-md px-2.5 py-1.5 hover:border-un1t-muted transition-colors"
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-bold text-un1t-text uppercase tracking-wide">
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {group.label}
                    </span>
                    <span className="text-[10px] text-un1t-muted">
                      {group.items.length} {group.items.length === 1 ? 'class' : 'classes'}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="space-y-1.5 mt-1.5 mb-1">
                      {group.items.map(cls => {
                        const full = cls.spots_left === 0
                        return (
                          <div key={cls.id} className="flex items-center justify-between gap-2 border border-un1t-border rounded-lg px-2.5 py-1.5">
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">{cls.name}</p>
                              <p className="text-[10px] text-un1t-muted truncate">
                                {fmtClockTime(cls.time_start_ms)}
                                {cls.trainers?.length ? ` · ${cls.trainers[0]}` : ''}
                                {cls.spots_left != null
                                  ? ` · ${full ? 'Full' : `${cls.spots_left} of ${cls.size} spots`}`
                                  : ''}
                              </p>
                            </div>
                            <button
                              disabled={booking || !glofoxMemberId || full}
                              onClick={() => bookClass(cls)}
                              className={`shrink-0 text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                                full
                                  ? 'bg-un1t-border text-un1t-muted cursor-not-allowed'
                                  : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed'
                              }`}
                            >
                              {full ? 'Full' : 'Book'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {classResult && (
          <p className={`text-xs mt-2 ${classResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
            {classResult.message}
            {classResult.bookingId && (
              <button
                onClick={() => undoClassBooking(classResult.bookingId)}
                disabled={booking}
                className="ml-2 underline text-un1t-subtle hover:text-un1t-text disabled:opacity-50"
              >
                Undo
              </button>
            )}
          </p>
        )}
      </div>

      {conversationId && (
        <label className="flex items-center gap-2 text-[11px] text-un1t-subtle">
          <input
            type="checkbox"
            checked={dropInThread}
            onChange={e => setDropInThread(e.target.checked)}
            className="rounded border-un1t-border"
          />
          {notifyLabel}
        </label>
      )}
    </div>
  )
}

export default BookPanel

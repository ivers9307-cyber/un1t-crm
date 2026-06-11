'use client'

// UIX-P2 — the unified inbox's contact command centre (right pane).
// Manage the person behind the thread without leaving the page:
//   Profile  — stage, tags, Glofox status, marketing consent toggles
//              (the existing ContactMarketingPreferencesCard — same
//              consent_log semantics as the STOP/START keywords),
//              quick actions (enrol in sequence, open full record).
//   Activity — compact timeline: activities + consent audit lines.
//   Book     — placeholder until UIX-P3 (Glofox probe results pending).

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  User, ListTodo, ExternalLink, Send, ShieldCheck,
  CircleDot, RefreshCw,
} from 'lucide-react'
import ContactMarketingPreferencesCard from '@/components/ContactMarketingPreferencesCard'
import SequencePicker from '@/components/SequencePicker'

function prettyStage(slug) {
  if (!slug) return null
  return slug.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
}

const TABS = [
  ['profile', 'Profile'],
  ['activity', 'Activity'],
  ['book', 'Book'],
]

// `channel` + `conversationId` identify the thread this pane sits
// beside, so a booking confirmation can be dropped straight into the
// conversation (best-effort — a closed WA window just skips it).
export default function CommandCentre({ contactId, locationId, canEditConsent, channel, conversationId }) {
  const [tab, setTab] = useState('profile')
  const [contact, setContact] = useState(null)
  const [activities, setActivities] = useState([])
  const [consentLog, setConsentLog] = useState([])
  const [eventTypes, setEventTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showSequencePicker, setShowSequencePicker] = useState(false)

  const load = useCallback(async () => {
    if (!contactId) return
    setLoading(true)
    const [bundle, log] = await Promise.all([
      fetch(`/api/contacts/${contactId}/command-centre`).then(r => r.json()).then(d => d, () => null),
      fetch(`/api/contacts/${contactId}/consent-log`).then(r => r.json()).then(d => d, () => null),
    ])
    if (bundle?.success) {
      setContact(bundle.contact)
      setActivities(bundle.activities || [])
      setEventTypes(bundle.event_types || [])
    }
    if (log?.success) setConsentLog(log.rows || [])
    setLoading(false)
  }, [contactId])

  useEffect(() => {
    setContact(null)
    setActivities([])
    setConsentLog([])
    setEventTypes([])
    setShowSequencePicker(false)
    load()
  }, [load])

  if (!contactId) return null

  const stage = prettyStage(contact?.pipeline_stage_slug)
  const tags = Array.isArray(contact?.tags) ? contact.tags : []
  const optedOut = contact?.wa_status === 'opted_out'

  // Activity tab: merge the activities timeline with consent audit
  // lines into one stream, newest first.
  const timeline = [
    ...activities.map(a => ({
      key: `a-${a.id}`,
      at: a.created_at,
      icon: <ListTodo size={12} className="text-un1t-subtle shrink-0" />,
      label: a.title || a.subject || a.description || a.type || 'Activity',
      meta: a.kind || a.type || null,
    })),
    ...consentLog.map(c => ({
      key: `c-${c.id}`,
      at: c.created_at,
      icon: <ShieldCheck size={12} className="text-amber-600 shrink-0" />,
      label: `${c.channel || 'consent'} ${c.action || ''}`.trim(),
      meta: c.source || null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-un1t-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <User size={16} className="text-un1t-subtle shrink-0" />
            <p className="font-semibold text-sm truncate">
              {contact?.name || contact?.first_name || 'Contact'}
            </p>
          </div>
          <button onClick={load} className="text-un1t-subtle hover:text-un1t-text" aria-label="Refresh contact">
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {stage && (
            <span className="text-[10px] font-semibold bg-blue-500/10 text-blue-700 px-2 py-0.5 rounded-full">
              {stage}
            </span>
          )}
          {contact?.glofox_membership_status && (
            <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full">
              Glofox: {contact.glofox_membership_status}
            </span>
          )}
          {optedOut && (
            <span className="text-[10px] font-semibold bg-red-500/10 text-red-700 px-2 py-0.5 rounded-full">
              WA unsubscribed
            </span>
          )}
          {tags.slice(0, 4).map(t => (
            <span key={t} className="text-[10px] bg-un1t-border/60 text-un1t-subtle px-2 py-0.5 rounded-full">
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-3 py-2 border-b border-un1t-border">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              tab === key
                ? 'bg-un1t-text text-un1t-black border-transparent'
                : 'border-un1t-border text-un1t-subtle hover:text-un1t-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading && !contact && (
          <p className="text-xs text-un1t-subtle text-center py-6">Loading…</p>
        )}

        {tab === 'profile' && contact && (
          <>
            {/* Quick actions */}
            <div className="relative space-y-1.5">
              <Link
                href={`/contacts/${contactId}`}
                className="flex items-center gap-2 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded-lg px-3 py-2 transition-colors"
              >
                <ExternalLink size={12} />
                Open full record
              </Link>
              <button
                onClick={() => setShowSequencePicker(v => !v)}
                className="w-full flex items-center gap-2 text-xs text-un1t-subtle hover:text-un1t-text border border-un1t-border rounded-lg px-3 py-2 transition-colors"
              >
                <Send size={12} />
                Enrol in sequence
              </button>
              {showSequencePicker && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1">
                  <SequencePicker
                    contactIds={[contactId]}
                    locationId={locationId}
                    variant="popover"
                    onClose={() => setShowSequencePicker(false)}
                    onSuccess={() => { setShowSequencePicker(false); load() }}
                  />
                </div>
              )}
            </div>

            {/* Marketing consent — the existing card, same consent_log
                semantics as the STOP/START keyword system. */}
            <ContactMarketingPreferencesCard
              contactId={contactId}
              canEdit={canEditConsent}
              glofoxMembershipStatus={contact?.glofox_membership_status}
            />
          </>
        )}

        {tab === 'activity' && (
          timeline.length === 0 ? (
            <p className="text-xs text-un1t-subtle text-center py-6">No activity yet.</p>
          ) : (
            <div className="space-y-2">
              {timeline.map(item => (
                <div key={item.key} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5">{item.icon || <CircleDot size={12} className="text-un1t-muted" />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-un1t-text truncate">{item.label}</p>
                    <p className="text-[10px] text-un1t-muted">
                      {timeAgo(item.at)}{item.meta ? ` · ${item.meta}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'book' && (
          <BookPanel
            contactId={contactId}
            locationId={locationId}
            glofoxMemberId={contact?.glofox_member_id || null}
            eventTypes={eventTypes}
            channel={channel}
            conversationId={conversationId}
            onBooked={load}
          />
        )}
      </div>
    </div>
  )
}

// ── Book tab (UIX-P3a) — consultation booking against the existing
// availability engine: pick event type → day chip → slot → book via
// the staff route → optionally drop a confirmation into the thread.
// Glofox class booking joins this panel in P3b once the probe
// results pin the event-listing endpoint.

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

function BookPanel({ contactId, locationId, glofoxMemberId, eventTypes, channel, conversationId, onBooked }) {
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
                  ? 'bg-un1t-text text-un1t-black border-transparent'
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

      {/* ── Glofox classes (UIX-P3b) ── */}
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
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
            {classes.map(cls => {
              const full = cls.spots_left === 0
              return (
                <div key={cls.id} className="flex items-center justify-between gap-2 border border-un1t-border rounded-lg px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{cls.name}</p>
                    <p className="text-[10px] text-un1t-muted truncate">
                      {fmtClassTime(cls.time_start_ms)}
                      {cls.trainers?.length ? ` · ${cls.trainers[0]}` : ''}
                      {cls.spots_left != null ? ` · ${full ? 'Full' : `${cls.spots_left} spots`}` : ''}
                    </p>
                  </div>
                  <button
                    disabled={booking || !glofoxMemberId || full}
                    onClick={() => bookClass(cls)}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {full ? 'Full' : 'Book'}
                  </button>
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
          Send confirmation in the chat
        </label>
      )}
    </div>
  )
}

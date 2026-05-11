'use client'

// Public booking widget. Calendly-style two-column layout that
// expands to three columns when a date is picked:
//
//   ┌──────────────┐  ┌──────────────┐
//   │ Event info   │  │ Calendar     │  ← initial state
//   │ Location     │  │              │
//   │ Duration     │  │ Time zone    │
//   └──────────────┘  └──────────────┘
//
//   ┌──────────────┐  ┌──────────────┐  ┌─────────┐
//   │ Event info   │  │ Calendar     │  │ Slots   │
//   │ Location     │  │ (date sel.)  │  │ Wed May│
//   │ Duration     │  │              │  │ 9:00am │
//   │              │  │ Time zone    │  │ 9:15am │
//   └──────────────┘  └──────────────┘  └─────────┘
//
// On mobile, columns stack vertically. The form step replaces
// the calendar/slots panel entirely so we keep the chrome clean.
//
// Available days are dotted (faint blue), selected day is solid
// (event colour). Inactive days are gray text without any
// background. Less padding everywhere than the old layout.

import { useState, useEffect } from 'react'
import { Clock, MapPin, ChevronLeft, ChevronRight, Check, AlertCircle, Globe } from 'lucide-react'
// formatDate uses LOCAL calendar components so a Mon-clicked date
// stays a Mon date string. Replaces the previous
// .toISOString().split('T')[0] which converts to UTC and (in
// Ireland BST = +1) shifted Mon→Sun, causing the slots API to look
// up Sunday's null availability and return zero slots — see the
// roster.js docstring for the full incident reasoning.
import { formatDate } from '@/lib/roster'

export default function BookingWidget({ slug }) {
  const [event, setEvent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Calendar state
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState(null)
  const [slots, setSlots] = useState([])
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState(null)

  // Form state
  const [step, setStep] = useState('calendar') // calendar, form, confirmed
  const [formData, setFormData] = useState({ name: '', email: '', phone: '+353 ' })
  const [customResponses, setCustomResponses] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [, setBookingResult] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  // (mig 081 race-tracking state removed in mig 082 — races now have
  // their own standalone signup widget at /race/[slug] and don't
  // share UI with the booking flow.)

  // Detected timezone — surfaces on the calendar pane so customers
  // know what zone the slot times are in (matches the Calendly
  // pattern). Fallback to "Europe/Dublin" if Intl can't resolve.
  const [viewerTimezone, setViewerTimezone] = useState('')
  useEffect(() => {
    try {
      setViewerTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Dublin')
    } catch {
      setViewerTimezone('Europe/Dublin')
    }
  }, [])

  // Load event details
  useEffect(() => {
    // /api/public/bookings/[slug] (Calendly templates) — moved
    // here from /api/public/events/[slug] in commit 6f6911a (E3 of
    // events expansion) when the multi-kind events feature claimed
    // the /api/public/events/* prefix for race / workshop / seminar
    // / open_day / masterclass signups.
    fetch(`/api/public/bookings/${slug}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) setEvent(d.data)
        else setError('Event not found')
        setLoading(false)
      })
      .catch(() => { setError('Failed to load event'); setLoading(false) })
  }, [slug])

  // Load slots when date is selected
  useEffect(() => {
    if (!selectedDate || !event) return
    setLoadingSlots(true)
    setSelectedSlot(null)
    const dateStr = formatDate(selectedDate)
    fetch(`/api/public/bookings/${slug}/slots?date=${dateStr}`)
      .then(r => r.json())
      .then(d => {
        setSlots(d.data?.slots || [])
        setLoadingSlots(false)
      })
      .catch(() => { setSlots([]); setLoadingSlots(false) })
  }, [selectedDate, slug, event])

  function formatTime(time) {
    const [h, m] = time.split(':').map(Number)
    const ampm = h >= 12 ? 'pm' : 'am'
    const h12 = h % 12 || 12
    return `${h12}:${m.toString().padStart(2, '0')}${ampm}`
  }

  function getDaysInMonth(date) {
    const year = date.getFullYear()
    const month = date.getMonth()
    const first = new Date(year, month, 1)
    const last = new Date(year, month + 1, 0)
    const days = []
    for (let i = 0; i < (first.getDay() || 7) - 1; i++) days.push(null)
    for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d))
    return days
  }

  // Separate the two reasons a date might not be bookable so the UI
  // can render them differently:
  //   - "beyond advance window" — date is real but bookings haven't
  //     opened yet for it; show a friendly "check back on YYYY-MM-DD"
  //     message instead of the generic "No times available."
  //   - "wrong day of week" — the event simply doesn't run that day;
  //     stays as the standard greyed-out non-clickable cell.
  function isWithinAdvanceWindow(date) {
    if (!event || !date) return false
    const today = new Date(); today.setHours(0, 0, 0, 0)
    if (date < today) return false
    const maxDate = new Date(today)
    maxDate.setDate(maxDate.getDate() + (event.max_advance_days || 30))
    return date <= maxDate
  }
  function isAvailableForDayOfWeek(date) {
    if (!event || !date) return false
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    return !!event.availability[dayNames[date.getDay()]]
  }
  function isAvailableDay(date) {
    return isWithinAdvanceWindow(date) && isAvailableForDayOfWeek(date)
  }
  // Returns the date at which this otherwise-valid day becomes
  // bookable (today + (date − today) − max_advance_days), formatted
  // for the slots-column message.
  function bookingsOpenOn(date) {
    if (!event || !date) return null
    const opens = new Date(date)
    opens.setDate(opens.getDate() - (event.max_advance_days || 30))
    return opens
  }

  function prevMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
  }
  function nextMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
  }

  function formatIrishPhone(raw) {
    let digits = raw.replace(/[^\d+]/g, '')
    if (digits.startsWith('0')) digits = '+353' + digits.slice(1)
    if (digits.match(/^[1-9]/) && !digits.startsWith('+')) digits = '+353' + digits
    if (digits.startsWith('+353') && digits.length > 4) {
      const local = digits.slice(4)
      if (local.length <= 2) return `+353 ${local}`
      if (local.length <= 5) return `+353 ${local.slice(0, 2)} ${local.slice(2)}`
      return `+353 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 9)}`
    }
    return raw
  }
  function phoneToE164(formatted) {
    const digits = formatted.replace(/[^\d+]/g, '')
    if (digits.startsWith('+353')) return digits
    if (digits.startsWith('0')) return '+353' + digits.slice(1)
    return digits
  }
  function handlePhoneChange(e) {
    const formatted = formatIrishPhone(e.target.value)
    setFormData(prev => ({ ...prev, phone: formatted }))
    setFieldErrors(prev => ({ ...prev, phone: null }))
  }
  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }
  function validatePhone(phone) {
    if (!phone || phone.trim() === '+353' || phone.trim() === '') return true
    const e164 = phoneToE164(phone)
    return /^\+353[1-9]\d{6,9}$/.test(e164)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    const errors = {}
    if (!formData.name.trim()) errors.name = 'Name is required'
    if (!validateEmail(formData.email)) errors.email = 'Please enter a valid email address'
    if (formData.phone && !validatePhone(formData.phone)) errors.phone = 'Please enter a valid Irish phone number'

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }
    setSubmitting(true)
    const res = await fetch('/api/public/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type_id: event.id,
        booking_date: formatDate(selectedDate),
        start_time: selectedSlot.start,
        customer_name: formData.name.trim(),
        customer_email: formData.email.trim().toLowerCase(),
        customer_phone: formData.phone ? phoneToE164(formData.phone) : null,
        custom_responses: customResponses,
      }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (data.success) {
      setBookingResult(data.data)
      setStep('confirmed')
    } else {
      setError(data.error || 'Failed to book. Please try again.')
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-md text-center py-20">
        <div className="animate-spin w-7 h-7 border-2 border-gray-200 border-t-gray-700 rounded-full mx-auto" />
      </div>
    )
  }
  if (error && !event) {
    return (
      <div className="w-full max-w-md text-center py-20">
        <AlertCircle size={36} className="mx-auto mb-3 text-red-500" />
        <p className="text-gray-700">{error}</p>
      </div>
    )
  }

  const days = getDaysInMonth(currentMonth)
  const showSlotsColumn = step === 'calendar' && !!selectedDate
  const location = event.locations || null
  const accent = event.color || '#111827'

  return (
    <div className="w-full max-w-3xl bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className={`grid ${showSlotsColumn ? 'md:grid-cols-[220px_1fr_180px]' : 'md:grid-cols-[220px_1fr]'} divide-y md:divide-y-0 md:divide-x divide-gray-200`}>

        {/* ───── Sidebar: event info + location ───── */}
        <aside className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: accent + '15' }}
            >
              <Clock size={14} style={{ color: accent }} />
            </div>
            {location?.name && (
              <span className="text-xs uppercase tracking-wider text-gray-500 truncate">{location.name}</span>
            )}
          </div>

          <div>
            <h1 className="text-xl font-bold text-gray-900 leading-snug">{event.name}</h1>
            {event.description && (
              <p className="text-sm text-gray-600 mt-1.5 leading-relaxed">{event.description}</p>
            )}
          </div>

          <div className="space-y-2 text-sm text-gray-600">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-gray-400 flex-shrink-0" />
              <span>{event.duration_minutes} min</span>
            </div>
            {location?.address && (
              <div className="flex items-start gap-2">
                <MapPin size={14} className="text-gray-400 mt-0.5 flex-shrink-0" />
                <span className="leading-snug">{location.address}</span>
              </div>
            )}
          </div>

          {/* Footer powered-by sits with the brand panel so it
              doesn't fight the calendar for vertical space. */}
          <div className="pt-4 mt-auto">
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Powered by UN1T</p>
          </div>
        </aside>

        {/* ───── Calendar / form / confirmation pane ───── */}
        <div className="p-5">
          {error && step !== 'confirmed' && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
            </div>
          )}

          {/* CALENDAR STEP */}
          {step === 'calendar' && (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-gray-900">Select a date &amp; time</h2>
              </div>

              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={prevMonth}
                  className="p-1.5 rounded-md hover:bg-gray-100 text-gray-600"
                  aria-label="Previous month"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-sm font-medium text-gray-900">
                  {currentMonth.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })}
                </span>
                <button
                  onClick={nextMonth}
                  className="p-1.5 rounded-md hover:bg-gray-100 text-gray-600"
                  aria-label="Next month"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              <div className="grid grid-cols-7 mb-1">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                  <div key={d} className="text-center text-[10px] font-medium uppercase tracking-wider text-gray-400 py-1">{d}</div>
                ))}
              </div>

              {/* Calendar grid. Each grid cell is the full click
                  target (generous for mobile taps), but the visible
                  circle is a fixed 32px chip centred inside. The
                  Calendly look — chip is clearly smaller than the
                  cell, lets the whole calendar shrink down. */}
              <div className="grid grid-cols-7">
                {days.map((day, i) => {
                  if (!day) return <div key={`empty-${i}`} className="h-9" />
                  const available = isAvailableDay(day)
                  const selected = selectedDate && day.toDateString() === selectedDate.toDateString()
                  const isToday = day.toDateString() === new Date().toDateString()
                  // Visual distinction: a Monday beyond max_advance_days
                  // shouldn't look like an "available Monday" with a tinted
                  // chip. Render it like a non-availability day (no tint,
                  // muted text) so the calendar honestly reflects what the
                  // user can click.
                  const beyondWindow = isAvailableForDayOfWeek(day) && !isWithinAdvanceWindow(day)
                  const titleHint = beyondWindow
                    ? `Bookings open ${(event.max_advance_days || 30)} days in advance`
                    : undefined

                  return (
                    <button
                      key={day.toISOString()}
                      disabled={!available}
                      onClick={() => setSelectedDate(day)}
                      title={titleHint}
                      className={`h-9 flex items-center justify-center text-sm transition-colors group
                        ${!available ? 'cursor-default' : 'cursor-pointer'}
                      `}
                    >
                      <span
                        className={`relative inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors
                          ${selected ? 'text-white font-semibold' : ''}
                          ${available && !selected ? 'text-gray-900 font-medium group-hover:bg-gray-100' : ''}
                          ${!available ? 'text-gray-300' : ''}
                        `}
                        style={
                          selected
                            ? { backgroundColor: accent }
                            : available
                              ? { backgroundColor: accent + '12' }
                              : undefined
                        }
                      >
                        {day.getDate()}
                        {isToday && !selected && (
                          <span
                            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
                            style={{ backgroundColor: accent }}
                          />
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Time-zone footer — anchors the calendar pane like
                  Calendly does, so customers see what zone the
                  slot times are in. */}
              <div className="mt-5 pt-4 border-t border-gray-100 flex items-center gap-2 text-xs text-gray-500">
                <Globe size={12} className="text-gray-400" />
                <span>Times shown in <span className="text-gray-700 font-medium">{viewerTimezone || 'Europe/Dublin'}</span></span>
              </div>
            </>
          )}

          {/* FORM STEP */}
          {step === 'form' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <button
                type="button"
                onClick={() => setStep('calendar')}
                className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-1"
              >
                <ChevronLeft size={14} /> Back
              </button>

              <div className="bg-gray-50 rounded-lg px-3 py-2.5 text-sm text-gray-700 border border-gray-200">
                <p className="font-medium text-gray-900">
                  {selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric' })}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {formatTime(selectedSlot.start)} – {formatTime(selectedSlot.end)} · {event.duration_minutes} min
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Full name *</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={e => { setFormData(prev => ({ ...prev, name: e.target.value })); setFieldErrors(prev => ({ ...prev, name: null })) }}
                    className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.name ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
                    placeholder="Your name"
                  />
                  {fieldErrors.name && <p className="text-xs text-red-600 mt-1">{fieldErrors.name}</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email *</label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={e => { setFormData(prev => ({ ...prev, email: e.target.value })); setFieldErrors(prev => ({ ...prev, email: null })) }}
                    onBlur={() => { if (formData.email && !validateEmail(formData.email)) setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' })) }}
                    className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.email ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
                    placeholder="you@example.com"
                  />
                  {fieldErrors.email && <p className="text-xs text-red-600 mt-1">{fieldErrors.email}</p>}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={handlePhoneChange}
                  onBlur={() => { if (!validatePhone(formData.phone)) setFieldErrors(prev => ({ ...prev, phone: 'Please enter a valid Irish phone number' })) }}
                  className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.phone ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
                  placeholder="+353 87 123 4567"
                />
                {fieldErrors.phone && <p className="text-xs text-red-600 mt-1">{fieldErrors.phone}</p>}
              </div>

              {(event.custom_fields || []).map(field => (
                <div key={field.id}>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {field.label} {field.required && '*'}
                  </label>

                  {field.type === 'text' && (
                    <input
                      type="text"
                      required={field.required}
                      value={customResponses[field.id] || ''}
                      onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
                    />
                  )}

                  {field.type === 'textarea' && (
                    <textarea
                      required={field.required}
                      value={customResponses[field.id] || ''}
                      onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                      rows={3}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:border-gray-500 focus:outline-none resize-none"
                    />
                  )}

                  {field.type === 'dropdown' && (
                    <select
                      required={field.required}
                      value={customResponses[field.id] || ''}
                      onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
                    >
                      <option value="">Select...</option>
                      {(field.options || []).map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  )}

                  {field.type === 'radio' && (
                    <div className="space-y-1.5 mt-1">
                      {(field.options || []).map(opt => (
                        <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="radio"
                            name={field.id}
                            value={opt}
                            required={field.required}
                            checked={customResponses[field.id] === opt}
                            onChange={() => setCustomResponses(prev => ({ ...prev, [field.id]: opt }))}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}

                  {field.type === 'checkbox' && (
                    <label className="flex items-center gap-2 text-sm text-gray-700 mt-1">
                      <input
                        type="checkbox"
                        checked={customResponses[field.id] === 'true'}
                        onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.checked ? 'true' : 'false' }))}
                      />
                      {field.label}
                    </label>
                  )}
                </div>
              ))}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-md text-white font-medium text-sm transition-colors disabled:opacity-60"
                style={{ backgroundColor: accent }}
              >
                {submitting ? 'Booking…' : 'Confirm booking'}
              </button>
            </form>
          )}

          {/* CONFIRMED STEP */}
          {step === 'confirmed' && (
            <div className="text-center py-8">
              <div className="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: accent + '15' }}>
                <Check size={26} style={{ color: accent }} />
              </div>
              <h2 className="text-lg font-bold text-gray-900 mb-1">Booking confirmed</h2>
              <p className="text-sm text-gray-600 mb-4">
                You&apos;re booked for <span className="font-medium text-gray-900">{selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric' })}</span> at <span className="font-medium text-gray-900">{formatTime(selectedSlot.start)}</span>.
              </p>
              <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-700 inline-block text-left border border-gray-200">
                <p className="font-medium text-gray-900">{event.name}</p>
                <p className="text-xs mt-0.5">
                  {selectedDate.toLocaleDateString('en-IE', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' · '}
                  {formatTime(selectedSlot.start)} – {formatTime(selectedSlot.end)}
                </p>
                {location?.name && <p className="text-xs text-gray-500 mt-1">{location.name}</p>}
              </div>
            </div>
          )}
        </div>

        {/* ───── Slot column (only when a date is selected) ───── */}
        {showSlotsColumn && (
          <aside className="p-5">
            <div className="text-sm font-semibold text-gray-900 mb-3">
              {selectedDate.toLocaleDateString('en-IE', { weekday: 'long' })}, {selectedDate.toLocaleDateString('en-IE', { day: 'numeric', month: 'long' })}
            </div>

            {loadingSlots ? (
              <div className="text-center py-6">
                <div className="animate-spin w-5 h-5 border-2 border-gray-200 border-t-gray-700 rounded-full mx-auto" />
              </div>
            ) : slots.length === 0 ? (
              // Two reasons slots can be empty: bookings haven't opened
              // yet for this date (within max_advance_days), vs the day
              // is genuinely unavailable / fully booked. Distinguish so
              // the customer doesn't think the event is full.
              isAvailableForDayOfWeek(selectedDate) && !isWithinAdvanceWindow(selectedDate) ? (
                <div className="py-4 text-sm text-gray-500 space-y-1">
                  <p>Bookings haven&apos;t opened for this date yet.</p>
                  {(() => {
                    const opens = bookingsOpenOn(selectedDate)
                    if (!opens) return null
                    return (
                      <p className="text-xs text-gray-400">
                        Check back from {opens.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })}.
                      </p>
                    )
                  })()}
                </div>
              ) : (
                <p className="text-sm text-gray-400 py-4">No times available.</p>
              )
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                {slots.map(slot => {
                  const selected = selectedSlot?.start === slot.start
                  return (
                    <button
                      key={slot.start}
                      onClick={() => setSelectedSlot(slot)}
                      onDoubleClick={() => { setSelectedSlot(slot); setStep('form') }}
                      className={`w-full py-2 rounded-md text-sm font-medium border transition-all
                        ${selected
                          ? 'text-white border-transparent'
                          : 'border-gray-200 text-gray-700 hover:border-gray-400'
                        }
                      `}
                      style={selected ? { backgroundColor: accent } : undefined}
                    >
                      {formatTime(slot.start)}
                    </button>
                  )
                })}
              </div>
            )}

            {selectedSlot && (
              <button
                onClick={() => setStep('form')}
                className="w-full mt-3 py-2 rounded-md text-white font-medium text-sm transition-colors"
                style={{ backgroundColor: accent }}
              >
                Continue
              </button>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

'use client'

import { useState, useEffect } from 'react'
import { Clock, ChevronLeft, ChevronRight, Check, AlertCircle } from 'lucide-react'

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

  // Load event details
  useEffect(() => {
    fetch(`/api/public/events/${slug}`)
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
    const dateStr = selectedDate.toISOString().split('T')[0]
    fetch(`/api/public/events/${slug}/slots?date=${dateStr}`)
      .then(r => r.json())
      .then(d => {
        setSlots(d.data?.slots || [])
        setLoadingSlots(false)
      })
      .catch(() => { setSlots([]); setLoadingSlots(false) })
  }, [selectedDate, slug, event])

  function formatTime(time) {
    const [h, m] = time.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
  }

  // Calendar helpers
  function getDaysInMonth(date) {
    const year = date.getFullYear()
    const month = date.getMonth()
    const first = new Date(year, month, 1)
    const last = new Date(year, month + 1, 0)
    const days = []
    // Pad start
    for (let i = 0; i < (first.getDay() || 7) - 1; i++) days.push(null)
    for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d))
    return days
  }

  function isAvailableDay(date) {
    if (!event || !date) return false
    const today = new Date(); today.setHours(0, 0, 0, 0)
    if (date < today) return false
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + (event.max_advance_days || 30))
    if (date > maxDate) return false
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
    return !!event.availability[dayNames[date.getDay()]]
  }

  function prevMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))
  }

  function nextMonth() {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))
  }

  // Format Irish phone: strip spaces, handle 08X → +353 8X
  function formatIrishPhone(raw) {
    let digits = raw.replace(/[^\d+]/g, '')
    // If they typed a local number starting with 0
    if (digits.startsWith('0')) {
      digits = '+353' + digits.slice(1)
    }
    // If they typed just digits without +353
    if (digits.match(/^[1-9]/) && !digits.startsWith('+')) {
      digits = '+353' + digits
    }
    // Format: +353 8X XXX XXXX
    if (digits.startsWith('+353') && digits.length > 4) {
      const local = digits.slice(4)
      if (local.length <= 2) return `+353 ${local}`
      if (local.length <= 5) return `+353 ${local.slice(0, 2)} ${local.slice(2)}`
      return `+353 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 9)}`
    }
    return raw
  }

  // Strip to E.164 for storage: +353871234567
  function phoneToE164(formatted) {
    const digits = formatted.replace(/[^\d+]/g, '')
    if (digits.startsWith('+353')) return digits
    if (digits.startsWith('0')) return '+353' + digits.slice(1)
    return digits
  }

  function handlePhoneChange(e) {
    let val = e.target.value
    // Don't let them delete the +353 prefix
    if (!val.startsWith('+353')) {
      val = '+353 '
    }
    setFormData(prev => ({ ...prev, phone: formatIrishPhone(val) }))
    setFieldErrors(prev => ({ ...prev, phone: null }))
  }

  function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  function validatePhone(phone) {
    if (!phone || phone.trim() === '+353' || phone.trim() === '+353 ') return true // optional, empty is fine
    const e164 = phoneToE164(phone)
    // Valid Irish mobile: +353 8X XXX XXXX (10 digits after +353 → total 13 chars)
    // Valid Irish landline: +353 1 XXX XXXX or +353 XX XXX XXXX
    return /^\+353\d{7,10}$/.test(e164)
  }

  function validateForm() {
    const errors = {}
    if (!formData.name.trim()) errors.name = 'Name is required'
    if (!formData.email.trim()) errors.email = 'Email is required'
    else if (!validateEmail(formData.email)) errors.email = 'Please enter a valid email address'
    if (!validatePhone(formData.phone)) errors.phone = 'Please enter a valid Irish phone number'
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!validateForm()) return
    setSubmitting(true)

    const phoneE164 = phoneToE164(formData.phone)
    const phoneToSend = phoneE164 === '+353' ? null : phoneE164

    const dateStr = selectedDate.toISOString().split('T')[0]
    const res = await fetch('/api/public/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type_id: event.id,
        booking_date: dateStr,
        start_time: selectedSlot.start,
        customer_name: formData.name,
        customer_email: formData.email,
        customer_phone: phoneToSend,
        custom_responses: customResponses,
        source: 'booking_page',
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
      <div className="w-full max-w-lg text-center py-20">
        <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-gray-800 rounded-full mx-auto" />
      </div>
    )
  }

  if (error && !event) {
    return (
      <div className="w-full max-w-lg text-center py-20">
        <AlertCircle size={40} className="mx-auto mb-3 text-red-500" />
        <p className="text-gray-600">{error}</p>
      </div>
    )
  }

  const days = getDaysInMonth(currentMonth)

  return (
    <div className="w-full max-w-lg">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="w-10 h-10 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ backgroundColor: event.color + '20' }}>
          <Clock size={20} style={{ color: event.color }} />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">{event.name}</h1>
        {event.description && <p className="text-gray-500 mt-1">{event.description}</p>}
        <p className="text-sm text-gray-400 mt-2 flex items-center justify-center gap-1">
          <Clock size={14} /> {event.duration_minutes} minutes
        </p>
      </div>

      {error && step !== 'confirmed' && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {/* Step: Calendar */}
      {step === 'calendar' && (
        <div>
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-4">
            <button onClick={prevMonth} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <ChevronLeft size={18} className="text-gray-600" />
            </button>
            <h2 className="font-semibold text-gray-900">
              {currentMonth.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })}
            </h2>
            <button onClick={nextMonth} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
              <ChevronRight size={18} className="text-gray-600" />
            </button>
          </div>

          {/* Day Headers */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} className="text-center text-xs text-gray-400 py-2">{d}</div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-1 mb-6">
            {days.map((day, i) => {
              if (!day) return <div key={`empty-${i}`} />
              const available = isAvailableDay(day)
              const selected = selectedDate && day.toDateString() === selectedDate.toDateString()
              const isToday = day.toDateString() === new Date().toDateString()

              return (
                <button
                  key={day.toISOString()}
                  disabled={!available}
                  onClick={() => setSelectedDate(day)}
                  className={`aspect-square flex items-center justify-center rounded-lg text-sm transition-all
                    ${selected ? 'text-un1t-white font-semibold' : ''}
                    ${available && !selected ? 'hover:bg-gray-100 text-gray-900 font-medium' : ''}
                    ${!available ? 'text-gray-300 cursor-not-allowed' : 'cursor-pointer'}
                    ${isToday && !selected ? 'ring-1 ring-gray-300' : ''}
                  `}
                  style={selected ? { backgroundColor: event.color } : {}}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          {/* Time Slots */}
          {selectedDate && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                {selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric' })}
              </h3>

              {loadingSlots ? (
                <div className="text-center py-6">
                  <div className="animate-spin w-6 h-6 border-2 border-gray-300 border-t-gray-800 rounded-full mx-auto" />
                </div>
              ) : slots.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No available slots on this date</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 max-h-60 overflow-y-auto">
                  {slots.map(slot => {
                    const selected = selectedSlot?.start === slot.start
                    return (
                      <button
                        key={slot.start}
                        onClick={() => setSelectedSlot(slot)}
                        className={`py-2.5 px-3 rounded-lg text-sm font-medium border transition-all
                          ${selected
                            ? 'text-un1t-white border-transparent'
                            : 'border-gray-200 text-gray-700 hover:border-gray-400'
                          }
                        `}
                        style={selected ? { backgroundColor: event.color } : {}}
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
                  className="w-full mt-4 py-3 rounded-lg text-un1t-white font-medium text-sm transition-colors"
                  style={{ backgroundColor: event.color }}
                >
                  Continue
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step: Form */}
      {step === 'form' && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <button
            type="button"
            onClick={() => setStep('calendar')}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2"
          >
            <ChevronLeft size={16} /> Back
          </button>

          <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 mb-4">
            <p className="font-medium text-gray-900">
              {selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
            <p>{formatTime(selectedSlot.start)} — {formatTime(selectedSlot.end)} · {event.duration_minutes} min</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={e => { setFormData(prev => ({ ...prev, name: e.target.value })); setFieldErrors(prev => ({ ...prev, name: null })) }}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none ${fieldErrors.name ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
              placeholder="Your name"
            />
            {fieldErrors.name && <p className="text-xs text-red-500 mt-1">{fieldErrors.name}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input
              type="email"
              required
              value={formData.email}
              onChange={e => { setFormData(prev => ({ ...prev, email: e.target.value })); setFieldErrors(prev => ({ ...prev, email: null })) }}
              onBlur={() => { if (formData.email && !validateEmail(formData.email)) setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' })) }}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none ${fieldErrors.email ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
              placeholder="you@example.com"
            />
            {fieldErrors.email && <p className="text-xs text-red-500 mt-1">{fieldErrors.email}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input
              type="tel"
              value={formData.phone}
              onChange={handlePhoneChange}
              onBlur={() => { if (!validatePhone(formData.phone)) setFieldErrors(prev => ({ ...prev, phone: 'Please enter a valid Irish phone number (e.g. +353 87 123 4567)' })) }}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none ${fieldErrors.phone ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-gray-500'}`}
              placeholder="+353 87 123 4567"
            />
            {fieldErrors.phone && <p className="text-xs text-red-500 mt-1">{fieldErrors.phone}</p>}
          </div>

          {/* Custom Fields */}
          {(event.custom_fields || []).map(field => (
            <div key={field.id}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.label} {field.required && '*'}
              </label>

              {field.type === 'text' && (
                <input
                  type="text"
                  required={field.required}
                  value={customResponses[field.id] || ''}
                  onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-gray-500 focus:outline-none"
                />
              )}

              {field.type === 'textarea' && (
                <textarea
                  required={field.required}
                  value={customResponses[field.id] || ''}
                  onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-gray-500 focus:outline-none resize-none"
                />
              )}

              {field.type === 'dropdown' && (
                <select
                  required={field.required}
                  value={customResponses[field.id] || ''}
                  onChange={e => setCustomResponses(prev => ({ ...prev, [field.id]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-gray-500 focus:outline-none"
                >
                  <option value="">Select...</option>
                  {(field.options || []).map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}

              {field.type === 'radio' && (
                <div className="space-y-2 mt-1">
                  {(field.options || []).map(opt => (
                    <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name={field.id}
                        value={opt}
                        required={field.required}
                        checked={customResponses[field.id] === opt}
                        onChange={() => setCustomResponses(prev => ({ ...prev, [field.id]: opt }))}
                        className="text-gray-700"
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
            className="w-full py-3 rounded-lg text-un1t-white font-medium text-sm transition-colors disabled:opacity-60"
            style={{ backgroundColor: event.color }}
          >
            {submitting ? 'Booking...' : 'Confirm Booking'}
          </button>
        </form>
      )}

      {/* Step: Confirmed */}
      {step === 'confirmed' && (
        <div className="text-center py-8">
          <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ backgroundColor: event.color + '20' }}>
            <Check size={32} style={{ color: event.color }} />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Booking Confirmed!</h2>
          <p className="text-gray-500 mb-4">
            You're booked for {selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric' })} at {formatTime(selectedSlot.start)}.
          </p>
          <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-600 inline-block text-left">
            <p><strong>Event:</strong> {event.name}</p>
            <p><strong>Date:</strong> {selectedDate.toLocaleDateString('en-IE', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
            <p><strong>Time:</strong> {formatTime(selectedSlot.start)} — {formatTime(selectedSlot.end)}</p>
            <p><strong>Duration:</strong> {event.duration_minutes} minutes</p>
          </div>
          <p className="text-xs text-gray-400 mt-6">Powered by UN1T</p>
        </div>
      )}
    </div>
  )
}

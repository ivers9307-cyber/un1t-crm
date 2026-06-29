'use client'

// /start booking funnel. Brief's step order: choose path → details → pick a
// slot → confirmed. Reuses the existing public booking APIs (no new booking
// endpoint). Class option is "coming soon" until Phase 2. On success the
// booking endpoint also fires a WhatsApp confirmation (source='meta_book').

import { useState, useEffect } from 'react'

const CONSULT_SLUG = 'free-un1t-consultation'

function dayList(maxAdvanceDays = 30) {
  // Next ~14 selectable days as YYYY-MM-DD (Dublin wall-clock, no UTC math).
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' })
  const label = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' })
  const out = []
  const base = Date.now()
  for (let i = 0; i < Math.min(14, maxAdvanceDays); i++) {
    const d = new Date(base + i * 86400000)
    out.push({ date: fmt.format(d), label: label.format(d) })
  }
  return out
}

const inputCls = 'w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 focus:outline-none focus:border-white/50'

export default function StartFunnel() {
  const [step, setStep] = useState('choose') // choose | details | calendar | done
  const [path, setPath] = useState(null)     // 'consultation'
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: false })
  const [event, setEvent] = useState(null)
  const [days] = useState(() => dayList())
  const [selectedDate, setSelectedDate] = useState(null)
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Load the consultation event once the user has chosen the consult path.
  useEffect(() => {
    if (path !== 'consultation') return
    fetch(`/api/public/bookings/${CONSULT_SLUG}`).then((r) => r.json()).then((j) => { if (j.success) setEvent(j.data) }).catch(() => {})
  }, [path])

  async function loadSlots(date) {
    setSelectedDate(date); setSlots([]); setSlotsLoading(true)
    try {
      const r = await fetch(`/api/public/bookings/${CONSULT_SLUG}/slots?date=${date}`)
      const j = await r.json()
      setSlots(j.success ? (j.data.slots || []) : [])
    } catch { setSlots([]) } finally { setSlotsLoading(false) }
  }

  function chooseConsult() { setPath('consultation'); setStep('details') }

  function detailsNext(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || form.phone.replace(/\D/g, '').length < 7 || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    setStep('calendar')
  }

  async function book(slot) {
    if (submitting || !event) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/public/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type_id: event.id, booking_date: selectedDate, start_time: slot.start,
          customer_name: `${form.first_name.trim()} ${form.last_name.trim()}`.trim(),
          customer_email: form.email.trim(), customer_phone: form.phone.trim(),
          marketing_consent: form.consent, source: 'meta_book',
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(j.error || 'That slot was just taken — pick another.'); return }
      setStep('done')
    } catch { setError('Something went wrong. Please try again.') } finally { setSubmitting(false) }
  }

  if (step === 'done') {
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re booked 🎉</p>
        <p className="text-white/70">We&apos;ve sent a WhatsApp confirming your consultation. See you at UN1T Stillorgan!</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-12 text-white">
      {step === 'choose' && (
        <div className="space-y-4">
          <h1 className="font-display font-extrabold uppercase text-3xl mb-6">How do you want to start?</h1>
          <button onClick={chooseConsult} className="w-full text-left rounded-2xl border-2 border-white/20 hover:border-white p-6 transition-colors">
            <div className="font-bold text-lg">Book a free consultation</div>
            <div className="text-white/60 text-sm mt-1">Meet a coach, talk goals, get a plan.</div>
          </button>
          <div className="w-full text-left rounded-2xl border-2 border-white/10 p-6 opacity-50 cursor-not-allowed">
            <div className="font-bold text-lg">Book a free class <span className="text-xs uppercase tracking-wider ml-2 text-white/50">Coming soon</span></div>
            <div className="text-white/50 text-sm mt-1">Jump straight into a session.</div>
          </div>
        </div>
      )}

      {step === 'details' && (
        <form onSubmit={detailsNext} className="space-y-3.5">
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Your details</h1>
          <input className={inputCls} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" />
          <input className={inputCls} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" />
          <input className={inputCls} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
          <input className={inputCls} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
          <label className="flex items-start gap-2.5 text-xs text-white/65 pt-1">
            <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-white" />
            <span>I&apos;d like to hear from UN1T Stillorgan by email, SMS and WhatsApp. <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
          </label>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button type="submit" className="lp-btn w-full">Next →</button>
        </form>
      )}

      {step === 'calendar' && (
        <div>
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Pick a time</h1>
          <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
            {days.map((d) => (
              <button key={d.date} onClick={() => loadSlots(d.date)}
                className={`shrink-0 px-4 py-3 rounded-xl border-2 text-sm ${selectedDate === d.date ? 'border-white bg-white text-black' : 'border-white/20 text-white'}`}>
                {d.label}
              </button>
            ))}
          </div>
          {!selectedDate && <p className="text-white/50 text-sm">Choose a day to see available times.</p>}
          {slotsLoading && <p className="text-white/50 text-sm">Loading times…</p>}
          {selectedDate && !slotsLoading && slots.length === 0 && <p className="text-white/50 text-sm">No times left that day — try another.</p>}
          <div className="grid grid-cols-3 gap-2">
            {slots.map((s) => (
              <button key={s.start} disabled={submitting} onClick={() => book(s)}
                className="px-3 py-3 rounded-xl border-2 border-white/20 hover:border-white text-sm disabled:opacity-50">
                {s.start}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
        </div>
      )}
    </div>
  )
}

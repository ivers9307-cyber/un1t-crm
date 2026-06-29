'use client'

// /start booking funnel. Choose path → details → pick a slot/class → done.
// Consultation reuses the public booking APIs (POST /api/public/book, which
// fires a WhatsApp confirm on source='meta_book'). Class enqueues to the async
// pipeline (POST /api/public/class-booking) → the cron books + WhatsApp-confirms.

import { useState, useEffect } from 'react'

const CONSULT_SLUG = 'free-un1t-consultation'

function dayList(maxAdvanceDays = 30) {
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
  const [step, setStep] = useState('choose') // choose | details | calendar | classpick | done | classdone
  const [path, setPath] = useState(null)     // 'consultation' | 'class'
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: false })
  const [event, setEvent] = useState(null)
  const [days] = useState(() => dayList())
  const [selectedDate, setSelectedDate] = useState(null)
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [classes, setClasses] = useState([])
  const [classesLoading, setClassesLoading] = useState(false)
  const [selectedClassDay, setSelectedClassDay] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Consultation: load the event once chosen.
  useEffect(() => {
    if (path !== 'consultation') return
    fetch(`/api/public/bookings/${CONSULT_SLUG}`)
      .then((r) => r.json())
      .then((j) => { if (j.success && j.data) setEvent(j.data); else setError("Couldn't load booking times — please try again shortly.") })
      .catch(() => setError("Couldn't load booking times — please try again shortly."))
  }, [path])

  // Class: load classes when entering the class picker.
  useEffect(() => {
    if (step !== 'classpick') return
    setClassesLoading(true)
    fetch('/api/public/classes')
      .then((r) => r.json())
      .then((j) => {
        const list = (j.success && j.data?.classes) ? j.data.classes : []
        setClasses(list)
        if (list.length) setSelectedClassDay(list[0].day)
      })
      .catch(() => setClasses([]))
      .finally(() => setClassesLoading(false))
  }, [step])

  async function loadSlots(date) {
    setSelectedDate(date); setSlots([]); setSlotsLoading(true)
    try {
      const r = await fetch(`/api/public/bookings/${CONSULT_SLUG}/slots?date=${date}`)
      const j = await r.json()
      setSlots(j.success ? (j.data.slots || []) : [])
    } catch { setSlots([]) } finally { setSlotsLoading(false) }
  }

  function chooseConsult() { setPath('consultation'); setError(null); setStep('details') }
  function chooseClass() { setPath('class'); setError(null); setStep('details') }

  function detailsNext(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || form.phone.replace(/\D/g, '').length < 7 || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    setStep(path === 'class' ? 'classpick' : 'calendar')
  }

  async function book(slot) {
    if (submitting) return
    if (!event) { setError("Couldn't load booking times — please refresh and try again."); return }
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

  async function bookClass(c) {
    if (submitting) return
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/public/class-booking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: c.event_id, class_name: c.name, starts_at: c.starts_at,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(j.error || 'Something went wrong — please try again.'); return }
      setStep('classdone')
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
  if (step === 'classdone') {
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">You&apos;re being booked in 🎉</p>
        <p className="text-white/70">Watch for a WhatsApp confirming your class. See you at UN1T Stillorgan!</p>
      </div>
    )
  }

  const classDays = Array.from(new Set(classes.map((c) => c.day)))
  const dayClasses = classes.filter((c) => c.day === selectedClassDay)

  return (
    <div className="max-w-xl mx-auto px-6 py-12 text-white">
      {step === 'choose' && (
        <div className="space-y-4">
          <h1 className="font-display font-extrabold uppercase text-3xl mb-6">How do you want to start?</h1>
          <button onClick={chooseConsult} className="w-full text-left rounded-2xl border-2 border-white/20 hover:border-white p-6 transition-colors">
            <div className="font-bold text-lg">Book a free consultation</div>
            <div className="text-white/60 text-sm mt-1">Meet a coach, talk goals, get a plan.</div>
          </button>
          <button onClick={chooseClass} className="w-full text-left rounded-2xl border-2 border-white/20 hover:border-white p-6 transition-colors">
            <div className="font-bold text-lg">Book a free class</div>
            <div className="text-white/60 text-sm mt-1">Jump straight into a session.</div>
          </button>
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

      {step === 'classpick' && (
        <div>
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Pick a class</h1>
          {classesLoading && <p className="text-white/50 text-sm">Loading classes…</p>}
          {!classesLoading && classes.length === 0 && <p className="text-white/50 text-sm">No classes available right now — try a consultation instead.</p>}
          {!classesLoading && classes.length > 0 && (
            <>
              <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
                {classDays.map((d) => {
                  const lbl = classes.find((c) => c.day === d)?.day_label || d
                  return (
                    <button key={d} onClick={() => setSelectedClassDay(d)}
                      className={`shrink-0 px-4 py-3 rounded-xl border-2 text-sm ${selectedClassDay === d ? 'border-white bg-white text-black' : 'border-white/20 text-white'}`}>
                      {lbl}
                    </button>
                  )
                })}
              </div>
              <div className="space-y-2">
                {dayClasses.map((c) => (
                  <button key={c.event_id} disabled={submitting} onClick={() => bookClass(c)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 border-white/20 hover:border-white text-left disabled:opacity-50">
                    <span><span className="font-bold">{c.time}</span> · {c.name}</span>
                    <span className="text-xs text-white/50">{c.spots_left} left</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
        </div>
      )}
    </div>
  )
}

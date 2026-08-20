'use client'

// Class-booking funnel. Details → pick a class → booked, then an optional
// consult upsell. Prop-driven + location-aware: `publicPath` scopes the class
// list + funnel telemetry; `consultSlug` selects the upsell booking type (empty
// ⇒ no upsell); all copy is passed in. Defaults reproduce the original
// Stillorgan /start funnel exactly. Rendered directly by /start and wrapped by
// the `class_funnel` landing-page block (see BlockRenderers.jsx).
//
// Class enqueues to POST /api/public/class-booking (async cron books +
// WhatsApp-confirms). Consult books via POST /api/public/book.

import { useState, useEffect, useRef } from 'react'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { trackFunnelStep } from '@/lib/funnel-track'
import ClassFunnelCheckout from '@/components/landing-page/ClassFunnelCheckout'

// Default copy = today's live Stillorgan /start funnel, so a bare
// <ClassFunnel /> is unchanged from the old StartFunnel.
const DEFAULTS = {
  publicPath:       'stillorgan',
  consultSlug:      'free-un1t-consultation',
  heading:          'Your first 3 classes are free',
  subhead:          'Pick a time that suits you. It takes about 30 seconds.',
  consentLabel:     "I'd like to hear from UN1T Stillorgan by email, SMS and WhatsApp.",
  classDoneTitle:   "You're being booked in 🎉",
  classDoneBody:    "That's the first of your 3 free classes — watch for a WhatsApp confirming it. See you at UN1T Stillorgan!",
  consultDoneTitle: "You're booked 🎉",
  consultDoneBody:  "You'll get a WhatsApp confirming your consultation if we have your number. See you at UN1T Stillorgan!",
}

const inputCls ='w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 focus:outline-none focus:border-white/50'

export default function ClassFunnel(props) {
  // Copy props: an empty string falls back to the default, so an operator who
  // leaves a field blank keeps our copy rather than a blank line.
  const {
    publicPath, heading, subhead, consentLabel,
    classDoneTitle, classDoneBody, consultDoneTitle, consultDoneBody,
  } = { ...DEFAULTS, ...Object.fromEntries(Object.entries(props || {}).filter(([, v]) => v != null && v !== '')) }
  // consultSlug is different: an explicit '' means "no consult upsell" and MUST
  // be honoured, so read it straight from props and only default when absent.
  const consultSlug = props?.consultSlug ?? DEFAULTS.consultSlug
  // STARTCONV.1 — LAND ON THE PICKER, not the form.
  //
  // Measured 2026-08-20: of 138 people who arrived from the 3-Class Trial
  // email, 26 submitted the details form — 112 left without ever seeing a
  // single class time. The form asked for four fields plus a consent tick
  // before showing any value, and hid the one thing that decides whether this
  // is viable for someone: is there a time they can actually make. Someone who
  // can't do 6:30am or 6pm was abandoning BEFORE finding that out, so in the
  // telemetry they were indistinguishable from someone who just drifted off.
  //
  // Nothing is lost by moving the form later: detailsNext never made a server
  // call, so no lead was ever captured at that step. Capture has always
  // happened at the booking POST, which is now simply one step further on.
  const [step, setStep] = useState('classpick') // classpick | details | calendar | payment | done | classdone
  const [chosenClass, setChosenClass] = useState(null)
  // STARTPREFILL.1 — drives the "these are the details we have" note, so
  // someone reading a prefilled form knows why it is filled and that it is
  // theirs to correct.
  const [prefilled, setPrefilled] = useState(false)
  const [payment, setPayment] = useState(null) // { paymentId, checkout } when requiresPayment
  const [path, setPath] = useState('class')   // 'class' (default) | 'consultation' (upsell only)
  // Marketing-consent defaults to ticked (operator's call — pre-ticked + required;
  // accepted GDPR/Planet49 risk to maximise opt-in). Still un-tickable, and the
  // booking confirmation is a UTILITY/transactional send that doesn't rely on it.
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [event, setEvent] = useState(null)
  const [days, setDays] = useState([])
  const [daysLoading, setDaysLoading] = useState(false)
  const [selectedDate, setSelectedDate] = useState(null)
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [classes, setClasses] = useState([])
  const [classesLoading, setClassesLoading] = useState(false)
  const [selectedClassDay, setSelectedClassDay] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Ad-click attribution (ADS-REPORT.2) — capture UTM/meta ad params from the
  // landing URL on mount, client-side only (never during SSR). Held in a ref
  // (not state) so it doesn't trigger a re-render; read once at submit time.
  const attributionRef = useRef(null)
  const sessionRef = useRef(null)
  // Declared above the effects that call them so the react-hooks lint sees them
  // in scope before use (they close over the reactive `publicPath`/`consultSlug`
  // props). Function declarations hoist, so order is presentational only.
  function buildAttribution() {
    const p = attributionRef.current || {}
    const hasSignal = p.meta_ad_id || p.utm_campaign || p.utm_content || p.utm_term
    return hasSignal ? {
      utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term,
      ad_provider: 'meta', ad_external_id: p.meta_ad_id,
    } : undefined
  }

  // Fire one funnel step to the Pixel + Vercel (diagnostics) AND to the CRM's
  // own capture endpoint (funnel_events) so the Ads dashboard can show the
  // drop-off, per-ad. Best-effort — telemetry never blocks the funnel.
  function fireStep(step, params = {}) {
    trackFunnelStep(step, params)
    try {
      const a = attributionRef.current || {}
      fetch('/api/public/funnel-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          location_path: publicPath, funnel: 'start', step,
          session_id: sessionRef.current,
          ad_provider: a.meta_ad_id ? 'meta' : undefined,
          ad_external_id: a.meta_ad_id,
          utm_campaign: a.utm_campaign, utm_content: a.utm_content, utm_term: a.utm_term,
          meta: params,
        }),
      }).catch(() => {})
    } catch { /* never block the funnel */ }
  }

  // Effects below keep their original dependency arrays ([]/[path]/[step]) on
  // purpose — fireStep/loadSlots/publicPath/consultSlug are deliberately NOT
  // added, so the funnel fires exactly as it did before (adding them would
  // re-run these effects on every render). eslint's exhaustive-deps warnings
  // here are expected and intentional.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    attributionRef.current = {
      utm_campaign: p.get('utm_campaign') || undefined,
      utm_content: p.get('utm_content') || undefined,
      utm_term: p.get('utm_term') || undefined,
      meta_ad_id: p.get('meta_ad_id') || undefined,
    }
    // Stable per-visit id so a visitor's steps group into one funnel journey.
    let sid = null
    try { sid = window.sessionStorage.getItem('start_sid') } catch { /* private mode */ }
    if (!sid) {
      sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      try { window.sessionStorage.setItem('start_sid', sid) } catch { /* private mode */ }
    }
    sessionRef.current = sid
    // Landed on the funnel — the step events that follow reveal the drop-off.
    fireStep('view')

    // STARTPREFILL.1 — if the visitor arrived from an email we already hold
    // their details in, fill the form in for them. PREFILL, NEVER SKIP: the
    // sequence copy encourages forwarding ("bring someone with you"), so a
    // link that jumped straight to booking would silently book the friend
    // under the original recipient's identity. Shown-but-filled makes that
    // visible and self-correcting — the friend sees a name that isn't theirs
    // and edits it.
    //
    // Best-effort throughout: any failure leaves an ordinary empty form, which
    // is exactly what a cold visitor gets. Never blocks the funnel.
    const c = p.get('c')
    if (c) {
      fetch(`/api/public/start-prefill?c=${encodeURIComponent(c)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!j?.success || !j.data) return
          const d = j.data
          setForm((f) => ({
            ...f,
            // Only fill a field the visitor has not already typed into, so a
            // slow response can never overwrite what someone is mid-way
            // through entering.
            first_name: f.first_name || d.first_name || '',
            last_name: f.last_name || d.last_name || '',
            email: f.email || d.email || '',
            phone: f.phone || d.phone || '',
          }))
          setPrefilled(true)
        })
        .catch(() => {})
    }
  }, [])

  // Consultation: load the event once chosen.
  useEffect(() => {
    if (path !== 'consultation' || !consultSlug) return
    fetch(`/api/public/bookings/${consultSlug}`)
      .then((r) => r.json())
      .then((j) => { if (j.success && j.data) setEvent(j.data); else setError("Couldn't load booking times — please try again shortly.") })
      .catch(() => setError("Couldn't load booking times — please try again shortly."))
  }, [path])

  // Class: load classes when entering the class picker.
  useEffect(() => {
    if (step !== 'classpick') return
    setClassesLoading(true)
    fetch(`/api/public/classes?path=${encodeURIComponent(publicPath)}`)
      .then((r) => r.json())
      .then((j) => {
        const list = (j.success && j.data?.classes) ? j.data.classes : []
        setClasses(list)
        if (list.length) setSelectedClassDay(list[0].day)
        // count=0 flags an empty picker (a dead end that would explain a drop)
        fireStep('slots_view', { kind: 'class', count: list.length })
      })
      .catch(() => setClasses([]))
      .finally(() => setClassesLoading(false))
  }, [step])

  async function loadSlots(date) {
    setSelectedDate(date); setSlots([]); setSlotsLoading(true)
    try {
      const r = await fetch(`/api/public/bookings/${consultSlug}/slots?date=${date}`)
      const j = await r.json()
      setSlots(j.success ? (j.data.slots || []) : [])
    } catch { setSlots([]) } finally { setSlotsLoading(false) }
  }

  // Consultation: load only the days that actually have an open slot, so the
  // calendar never shows a dead day. Auto-opens the first available day.
  useEffect(() => {
    if (step !== 'calendar') return
    setDaysLoading(true)
    fetch(`/api/public/bookings/${consultSlug}/availability`)
      .then((r) => r.json())
      .then((j) => {
        const list = (j.success && j.data?.days) ? j.data.days : []
        setDays(list)
        if (list.length) loadSlots(list[0].date)
        fireStep('slots_view', { kind: 'consult', count: list.length })
      })
      .catch(() => setDays([]))
      .finally(() => setDaysLoading(false))
  }, [step])

  // Consult upsell (from the class success screen). Details are already captured;
  // flipping path→consultation loads the consult event, step→calendar loads its days.
  function addConsult() { setError(null); setPath('consultation'); setStep('calendar') }

  function pickClass(c) {
    setError(null)
    setChosenClass(c)
    setStep('details')
  }

  async function detailsNext(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    if (!isValidMobileNumber(form.phone)) {
      setError('Please enter a valid mobile number (e.g. 087 123 4567).'); return
    }
    fireStep('details')
    // STARTCONV.1 — the form submit IS the booking now. `details` still fires
    // first and separately, so the drop between seeing times and completing
    // the form stays measurable.
    await bookClass(chosenClass)
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
          attribution: buildAttribution(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(j.error || 'That slot was just taken — pick another.'); return }
      fireStep('booked_consult')
      setStep('done')
    } catch { setError('Something went wrong. Please try again.') } finally { setSubmitting(false) }
  }

  async function bookClass(c) {
    if (submitting) return
    if (!c) { setError('Pick a class first.'); setStep('classpick'); return }
    setSubmitting(true); setError(null)
    try {
      const r = await fetch('/api/public/class-booking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: publicPath,
          event_id: c.event_id, class_name: c.name, starts_at: c.starts_at,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          attribution: buildAttribution(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        // STARTCONV.1 — the class can fill while they are typing. Send them
        // back to the picker rather than leaving them on a form whose submit
        // can never succeed. `form` is component state, so everything they
        // typed survives the step change — say so, or it reads as lost work.
        if (j.code === 'class_unavailable') {
          setChosenClass(null)
          setStep('classpick')
          setError('That class filled up while you were typing. Pick another one — your details are saved.')
          return
        }
        setError(j.error || 'Something went wrong — please try again.'); return
      }
      if (j.data?.requiresPayment) {
        setPayment({ paymentId: j.data.paymentId, checkout: j.data.checkout })
        fireStep('payment_view')
        setStep('payment')
        return
      }
      fireStep('booked_class')
      setStep('classdone')
    } catch { setError('Something went wrong. Please try again.') } finally { setSubmitting(false) }
  }

  const classDays = Array.from(new Set(classes.map((c) => c.day)))
  const dayClasses = classes.filter((c) => c.day === selectedClassDay)

  // The funnel sits as a single frosted card over the hero image (see
  // start/page.js) — every step renders inside this one wrapper so the card
  // never jumps between an early-return layout and the main one.
  return (
    <div className="w-full max-w-lg rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl shadow-2xl shadow-black/50 px-6 py-8 sm:px-9 sm:py-10 text-white">
      {step === 'done' && (
        <div className="text-center py-6">
          <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{consultDoneTitle}</p>
          <p className="text-white/70">{consultDoneBody}</p>
        </div>
      )}
      {step === 'payment' && payment && (
        <ClassFunnelCheckout
          paymentId={payment.paymentId}
          checkout={payment.checkout}
          onPaid={() => { fireStep('booked_class'); setStep('classdone') }}
          onCancel={() => { setStep('classpick') }}
        />
      )}

      {step === 'classdone' && (
        <div className="py-6">
          <div className="text-center mb-6">
            <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{classDoneTitle}</p>
            <p className="text-white/70">{classDoneBody}</p>
          </div>
          {consultSlug && (
            <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
              <div className="font-bold text-lg">Want a coach in your corner?</div>
              <div className="text-white/60 text-sm mt-1 mb-4">Add a free consult — meet a coach, talk goals, get a plan. On us.</div>
              <button type="button" onClick={addConsult} className="lp-btn w-full">Add a free consult →</button>
            </div>
          )}
        </div>
      )}

      {step === 'details' && (
        <form onSubmit={detailsNext} className="space-y-3.5">
          {/* STARTCONV.1 — keep the chosen class on screen. It is what they
              came for, it is the reason to finish the form, and if the class
              fills mid-typing they need to recognise what changed. */}
          {chosenClass && (
            <div className="mb-4 rounded-xl border-2 border-white/20 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-white/50">You&apos;re booking</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-base"><span className="font-bold">{chosenClass.time}</span> · {chosenClass.name}</span>
                <button
                  type="button"
                  onClick={() => { setError(null); setStep('classpick') }}
                  className="shrink-0 text-xs underline text-white/60 hover:text-white"
                >
                  Change
                </button>
              </div>
              {chosenClass.day_label && <div className="mt-1 text-xs text-white/50">{chosenClass.day_label}</div>}
            </div>
          )}
          <div className="mb-4">
            <h1 className="font-display font-extrabold uppercase text-2xl mb-2">Last step</h1>
            <p className="text-white/60 text-sm">
              {prefilled
                ? 'These are the details we have for you — change anything that looks wrong.'
                : 'We just need these to book you in.'}
            </p>
          </div>
          <input className={inputCls} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" />
          <input className={inputCls} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" />
          <input className={inputCls} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
          <input className={inputCls} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
          <label className="flex items-start gap-2.5 text-xs text-white/65 pt-1">
            <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-white" />
            <span>{consentLabel} <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
          </label>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button type="submit" disabled={submitting} className="lp-btn w-full disabled:opacity-50">
            {submitting ? 'Booking…' : 'Confirm my class →'}
          </button>
        </form>
      )}

      {step === 'calendar' && (
        <div>
          <h1 className="font-display font-extrabold uppercase text-2xl mb-4">Pick a time</h1>
          {daysLoading && <p className="text-white/50 text-sm">Loading available days…</p>}
          {!daysLoading && days.length === 0 && (
            <p className="text-white/50 text-sm">No consultation times available right now — message us and we&apos;ll sort one for you.</p>
          )}
          {days.length > 0 && (
            <>
              <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
                {days.map((d) => (
                  <button key={d.date} onClick={() => loadSlots(d.date)}
                    className={`shrink-0 px-4 py-3 rounded-xl border-2 text-sm ${selectedDate === d.date ? 'border-white bg-white text-black' : 'border-white/20 text-white'}`}>
                    {d.label}
                  </button>
                ))}
              </div>
              {slotsLoading && <p className="text-white/50 text-sm">Loading times…</p>}
              {selectedDate && !slotsLoading && slots.length === 0 && <p className="text-white/50 text-sm">No times left that day — try another.</p>}
              <div className="grid grid-cols-3 gap-2">
                {slots.map((s) => (
                  <button key={s.start} disabled={!event || submitting} onClick={() => book(s)}
                    className="px-3 py-3 rounded-xl border-2 border-white/20 hover:border-white text-sm disabled:opacity-50">
                    {s.start}
                  </button>
                ))}
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
        </div>
      )}

      {step === 'classpick' && (
        <div>
          {/* STARTCONV.1 — the picker is the landing step now, so it carries
              the headline the details form used to. */}
          <div className="mb-4">
            <h1 className="font-display font-extrabold uppercase text-3xl mb-2">{heading}</h1>
            <p className="text-white/60 text-sm">{subhead}</p>
          </div>
          {classesLoading && <p className="text-white/50 text-sm">Loading classes…</p>}
          {!classesLoading && classes.length === 0 && <p className="text-white/50 text-sm">No classes are bookable online right now — message us and we&apos;ll get you booked in.</p>}
          {!classesLoading && classes.length > 0 && (
            <>
              <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
                {classDays.map((d) => {
                  const lbl = classes.find((c) => c.day === d)?.day_label || d
                  return (
                    <button key={d} type="button" onClick={() => setSelectedClassDay(d)}
                      className={`shrink-0 px-4 py-3 rounded-xl border-2 text-sm ${selectedClassDay === d ? 'border-white bg-white text-black' : 'border-white/20 text-white'}`}>
                      {lbl}
                    </button>
                  )
                })}
              </div>
              <div className="space-y-2">
                {dayClasses.map((c) => (
                  <button key={c.event_id} type="button" disabled={submitting} onClick={() => pickClass(c)}
                    className="w-full px-4 py-3 rounded-xl border-2 border-white/20 hover:border-white text-left disabled:opacity-50">
                    <span><span className="font-bold">{c.time}</span> · {c.name}</span>
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

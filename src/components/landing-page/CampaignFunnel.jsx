'use client'

// CampaignFunnel — FIFTYPLUS.1: the booking card on a campaign page
// (/50plus). One class, one trial plan, so the offer IS the schedule: the
// card opens on date tiles (the campaign's slots over the next fortnight, from
// GET /api/public/classes?campaign=), then the details, then booked. The POST
// is the same /api/public/class-booking the class funnel uses, with
// `campaign` so the server takes the trial pair, tag and allow-list from the
// campaign_funnel block.
//
// Light card (black on off-white), type a step up: the reader is 55-70 on a
// phone. Every word is the block's (`copy`, resolved server-side); the
// server's refusals come back in the operator's words and are shown as they
// are. Telemetry (funnel steps, the browser Lead) never blocks the booking.
import { useEffect, useRef, useState } from 'react'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { trackFunnelStep } from '@/lib/funnel-track'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath } from '@/lib/meta-pixel-paths'
import { stripDashes } from '@/lib/un1t-online-funnel-copy'
import { readAttributionFromUrl, buildAttribution, readFbpCookie, funnelSessionId } from '@/lib/campaign-funnel-attribution'

const VISIBLE_TILES = 3
const FUNNEL = '50plus'
const inputCls = 'w-full bg-white border border-black/15 rounded-xl px-4 py-3.5 text-base text-black placeholder-black/40 focus:outline-none focus:border-black/60'
const ctaCls = 'w-full rounded-full bg-black text-white py-4 px-6 font-bold text-base disabled:opacity-50'

/** The slots grouped by day, in day order. Pure. */
export function cadenceGroups(classes) {
  const byDay = new Map()
  for (const c of Array.isArray(classes) ? classes : []) {
    if (!c || !c.day) continue
    if (!byDay.has(c.day)) byDay.set(c.day, { day: c.day, day_label: c.day_label || c.day, classes: [] })
    byDay.get(c.day).classes.push(c)
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** The CTA label: `{day}` is the weekday off day_label, `{time}` the slot's time. */
export function ctaLabelFor(template, cls) {
  const t = typeof template === 'string' && template.trim() ? template : 'Book {day} {time}'
  const weekday = String(cls?.day_label || '').split(' ')[0] || ''
  return t.replace('{day}', weekday).replace('{time}', cls?.time || '').replace(/\s+/g, ' ').trim()
}

function Tile({ cls, selected, onPick }) {
  const [weekday, ...rest] = String(cls.day_label || '').split(' ')
  const dateNumber = rest[0] || ''
  const month = rest.slice(1).join(' ')
  return (
    <button
      type="button"
      onClick={() => onPick(cls)}
      aria-pressed={selected}
      className={`rounded-2xl px-2 py-3 text-center transition ${selected ? 'bg-black text-white' : 'bg-white border border-black/15 text-black hover:border-black/40'}`}
    >
      <span className={`block text-xs ${selected ? 'text-white/70' : 'text-black/60'}`}>{weekday}</span>
      <span className="block font-display font-extrabold text-2xl leading-tight">{dateNumber}</span>
      <span className={`block text-xs ${selected ? 'text-white/80' : 'text-black/70'}`}>{month ? `${month} · ` : ''}{cls.time}</span>
      <span className="sr-only">{cls.day_label}</span>
    </button>
  )
}

export default function CampaignFunnel({ publicPath, campaign, copy, locationName = '' }) {
  const c = copy && typeof copy === 'object' ? copy : {}
  const [step, setStep] = useState('pick') // pick | details | done
  const [classes, setClasses] = useState([])
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)
  const [chosen, setChosen] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const attributionRef = useRef({})
  const sessionRef = useRef(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  function fireStep(name, params = {}) {
    trackFunnelStep(`${FUNNEL}_${name}`, params)
    try {
      const a = attributionRef.current || {}
      fetch('/api/public/funnel-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          location_path: publicPath, funnel: FUNNEL, step: name,
          session_id: sessionRef.current,
          ad_provider: a.meta_ad_id ? 'meta' : undefined,
          ad_external_id: a.meta_ad_id,
          utm_campaign: a.utm_campaign, utm_content: a.utm_content, utm_term: a.utm_term,
          meta: params,
        }),
      }).catch(() => {})
    } catch { /* never block the funnel */ }
  }

  useEffect(() => {
    attributionRef.current = readAttributionFromUrl(window.location.search)
    let storage = null
    try { storage = window.sessionStorage } catch { /* private mode */ }
    sessionRef.current = funnelSessionId(storage)
    fireStep('view')
    let alive = true
    fetch(`/api/public/classes?path=${encodeURIComponent(publicPath)}&campaign=${encodeURIComponent(campaign)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        const list = (j?.success && Array.isArray(j.data?.classes)) ? j.data.classes : []
        const ok = j?.data?.campaign?.configured !== false
        setClasses(list)
        setConfigured(ok)
        if (list.length) setChosen(list[0])
        if (!ok) fireStep('not_configured')
        else if (!list.length) fireStep('empty')
      })
      .catch(() => { if (alive) setClasses([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = cadenceGroups(classes)
  const flat = groups.flatMap((g) => g.classes)
  const visible = showAll ? flat : flat.slice(0, VISIBLE_TILES)
  const hiddenCount = flat.length - visible.length

  function pick(cls) {
    setChosen(cls)
    setError(null)
  }

  function toDetails() {
    if (!chosen) return
    fireStep('pick', { event_id: chosen.event_id })
    setError(null)
    setStep('details')
  }

  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    if (!chosen) { setError('Pick a class first.'); setStep('pick'); return }
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim()) { setError('Please fill in every field.'); return }
    if (!isValidMobileNumber(form.phone.trim())) { setError('Please enter a valid mobile number.'); return }
    if (!form.consent) { setError('Please tick the box to continue.'); return }
    setSubmitting(true); setError(null)
    fireStep('details')
    const leadEventId = newLeadEventId()
    try {
      const r = await fetch('/api/public/class-booking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: publicPath, campaign,
          event_id: chosen.event_id, class_name: chosen.name, starts_at: chosen.starts_at,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          attribution: buildAttribution(attributionRef.current, readFbpCookie(typeof document !== 'undefined' ? document.cookie : '')),
          visit: readVisitOrigin() || undefined,
          lead_event_id: leadEventId,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        if (j.code === 'class_unavailable') {
          setStep('pick')
          setError('That class filled up while you were typing. Pick another one, your details are saved.')
          return
        }
        setError(stripDashes(j.error || 'Something went wrong. Please try again.'))
        return
      }
      fireBrowserLead({
        pixelIds: typeof window !== 'undefined' ? metaPixelIdsForPath(window.location.pathname) : [],
        eventId: leadEventId,
        userData: pixelUserData({ email: form.email, phone: form.phone, firstName: form.first_name, lastName: form.last_name }),
        contentName: chosen.name,
      })
      fireStep('booked')
      setStep('done')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const card = 'w-full max-w-lg rounded-3xl bg-lp-pale text-black p-6 sm:p-8 shadow-xl shadow-black/10'
  const cta = chosen ? ctaLabelFor(c.cta_label, chosen) : ''

  if (step === 'done') {
    return (
      <div id="book" className={`${card} text-center`}>
        <p className="font-display font-extrabold uppercase text-3xl mb-3">{c.done_title}</p>
        <p className="text-black/70 text-lg">{c.done_body}</p>
      </div>
    )
  }

  if (step === 'details' && chosen) {
    return (
      <div id="book" className={card}>
        <form onSubmit={submit} className="space-y-3.5">
          <div className="mb-4 rounded-xl border-2 border-black/15 bg-white px-4 py-3">
            <div className="text-[11px] uppercase tracking-wider text-black/55">You&apos;re booking</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="text-base"><span className="font-bold">{chosen.time}</span> · {chosen.day_label}</span>
              <button type="button" onClick={() => { setError(null); setStep('pick') }} className="shrink-0 text-sm underline text-black/60 hover:text-black">Change</button>
            </div>
          </div>
          <div className="mb-4">
            <h2 className="font-display font-extrabold uppercase text-2xl mb-2">{c.details_title}</h2>
            <p className="text-black/60 text-base">{c.details_body}</p>
          </div>
          <input className={inputCls} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" />
          <input className={inputCls} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" />
          <input className={inputCls} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
          <input className={inputCls} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" />
          <label className="flex items-start gap-2.5 text-sm text-black/65 pt-1">
            <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-black" />
            <span>{c.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
          </label>
          {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
          <button type="submit" disabled={submitting} className={ctaCls}>{cta}</button>
          <p className="text-center text-sm text-black/55">{c.reassurance}</p>
        </form>
      </div>
    )
  }

  return (
    <div id="book" className={card}>
      <div className="text-[11px] uppercase tracking-[0.3em] font-semibold text-black/55">Step 1 of 2</div>
      <h2 className="font-display font-extrabold uppercase text-2xl sm:text-3xl mt-2 mb-2">{c.pick_title}</h2>
      <p className="text-black/60 text-base mb-5">{c.pick_body}</p>
      {loading ? (
        <p className="text-black/50 text-base py-6 text-center">Checking the timetable…</p>
      ) : !configured ? (
        <p className="text-black/70 text-lg py-4" role="status">{c.not_configured_text}</p>
      ) : flat.length === 0 ? (
        <p className="text-black/70 text-lg py-4" role="status">{c.no_classes_text}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            {visible.map((cls) => (
              <Tile key={cls.event_id} cls={cls} selected={chosen?.event_id === cls.event_id} onPick={pick} />
            ))}
          </div>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className="block mx-auto mt-3 text-sm underline text-black/60 hover:text-black">
              More dates ({hiddenCount})
            </button>
          )}
          {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
          <button type="button" onClick={toDetails} disabled={!chosen} className={`${ctaCls} mt-5`}>{cta}</button>
          <p className="text-center text-sm text-black/55 mt-3">{c.reassurance}</p>
        </>
      )}
      {locationName ? <span className="sr-only">{locationName}</span> : null}
    </div>
  )
}

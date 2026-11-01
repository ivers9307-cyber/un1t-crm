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
//
// PAGES.1 — with a `page` prop (the [slug] route passes the page's slug) the
// list, the booking and the funnel events name `{ page, studio: publicPath }`
// and the server reads everything else from the page's studio row; without
// it the card sends `path` + `campaign` as before.
//
// PAGES.1 — `onEditCopy(key, value)` (optional, the editor's preview only)
// makes the pick and done words (EDITABLE_COPY_KEYS) editable in place; the
// booking itself stays live. Without it the card renders exactly as before.
import { useEffect, useRef, useState } from 'react'
import EditableText from './EditableText'
import ClassPickStep, { useClassList, cadenceGroups, ctaLabelFor, campaignFunnelTarget, campaignFunnelClassesUrl, PICK_CTA_CLS } from './ClassPickStep'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { trackFunnelStep } from '@/lib/funnel-track'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath, pageLocationIdFromDocument } from '@/lib/meta-pixel-paths'
import { stripDashes } from '@/lib/un1t-online-funnel-copy'
import { readAttributionFromUrl, buildAttribution, readFbpCookie, funnelSessionId } from '@/lib/campaign-funnel-attribution'
import { customerErrorText } from '@/lib/page-request-errors'

// The card words the editor's preview may edit in place (onEditCopy).
export const EDITABLE_COPY_KEYS = Object.freeze(['pick_title', 'pick_body', 'done_title', 'done_body'])
const FUNNEL = '50plus'
// The CRM's funnel_events accepts only VALID_STEPS (src/lib/funnel-events.js),
// so the card's steps map onto the /start vocabulary the Ads report counts;
// steps with no CRM twin (empty, not_configured, unavailable) go to the
// Pixel and Vercel only.
const CRM_STEP = { view: 'view', pick: 'path_class', details: 'details', booked: 'booked_class' }
const inputCls = 'w-full bg-white border border-black/15 rounded-xl px-4 py-3.5 text-base text-black placeholder-black/40 focus:outline-none focus:border-black/60'
const ctaCls = PICK_CTA_CLS

// CLASSFIRST.1 — the tiles, the grouping and the request helpers moved to
// ClassPickStep (shared with /trial and /corp); re-exported so every import
// of this module keeps working.
export { cadenceGroups, ctaLabelFor, campaignFunnelTarget, campaignFunnelClassesUrl }

export default function CampaignFunnel({ publicPath, campaign, page = null, copy, locationName = '', onEditCopy = null }) {
  const c = copy && typeof copy === 'object' ? copy : {}
  const words = (key, multiline = false) => (onEditCopy && EDITABLE_COPY_KEYS.includes(key)
    ? <EditableText value={c[key] || ''} multiline={multiline} onChange={(v) => onEditCopy(key, v)} />
    : c[key])
  const [step, setStep] = useState('pick') // pick | details | done
  const [chosen, setChosen] = useState(null)
  // CLASSFIRST.1 — the list lives in ClassPickStep; bumping this re-fetches
  // it (after class_unavailable), and the first load alone preselects.
  const [reloadKey, setReloadKey] = useState(0)
  const preselectRef = useRef(true)
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const attributionRef = useRef({})
  const sessionRef = useRef(null)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  function fireStep(name, params = {}) {
    trackFunnelStep(`${FUNNEL}_${name}`, params)
    const crmStep = CRM_STEP[name]
    if (!crmStep) return
    try {
      const a = attributionRef.current || {}
      fetch('/api/public/funnel-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          ...(page ? { page, studio: publicPath || undefined } : { location_path: publicPath }),
          funnel: FUNNEL, step: crmStep,
          session_id: sessionRef.current,
          ad_provider: a.meta_ad_id ? 'meta' : undefined,
          ad_external_id: a.meta_ad_id,
          utm_campaign: a.utm_campaign, utm_content: a.utm_content, utm_term: a.utm_term,
          meta: params,
        }),
      }).catch(() => {})
    } catch { /* never block the funnel */ }
  }

  // What the list said: the first load preselects the first slot (a reload
  // after class_unavailable leaves nothing chosen until they pick), and the
  // empty states go to telemetry.
  function onLoaded({ classes: list, configured, unavailable }) {
    if (preselectRef.current && list.length) setChosen(list[0])
    preselectRef.current = false
    if (!configured) fireStep('not_configured')
    else if (unavailable) fireStep('unavailable')
    else if (!list.length) fireStep('empty')
  }

  const list = useClassList({ page, publicPath, campaign, reloadKey, onLoaded })

  useEffect(() => {
    attributionRef.current = readAttributionFromUrl(window.location.search)
    let storage = null
    try { storage = window.sessionStorage } catch { /* private mode */ }
    sessionRef.current = funnelSessionId(storage)
    fireStep('view')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
          ...campaignFunnelTarget({ page, publicPath, campaign }),
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
          // The slot they chose is gone: clear it and reload the list so the
          // same tile cannot be pressed into the same refusal.
          setChosen(null)
          setStep('pick')
          setError('That class filled up while you were typing. Pick another one, your details are saved.')
          setReloadKey((k) => k + 1)
          return
        }
        setError(stripDashes(customerErrorText(j.error, 'Something went wrong. Please try again.')))
        return
      }
      fireBrowserLead({
        pixelIds: typeof window !== 'undefined' ? metaPixelIdsForPath(window.location.pathname, { primaryLocationId: pageLocationIdFromDocument() }) : [],
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
        <p className="font-display font-extrabold uppercase text-3xl mb-3">{words('done_title')}</p>
        <p className="text-black/70 text-lg">{words('done_body', true)}</p>
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
      <ClassPickStep
        list={list}
        copy={c}
        chosen={chosen}
        onPick={pick}
        onContinue={toDetails}
        ctaLabel={cta}
        error={error}
        title={words('pick_title')}
        body={words('pick_body', true)}
        reassurance={c.reassurance}
      />
      {locationName ? <span className="sr-only">{locationName}</span> : null}
    </div>
  )
}

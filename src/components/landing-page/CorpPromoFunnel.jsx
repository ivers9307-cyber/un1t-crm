'use client'

// CorpPromoFunnel — CORPPROMO.1: the visitor's side of a /corp promo, in the
// /trial card's look. The form (details, consent, un1t.online's terms tick) →
// POST /api/public/corp-claims → one of:
//   granted: the server's done title and message (the credits and the day
//     they expire, in the studio's zone);
//   a refusal (active_member, already_claimed, free_trial_used, trained,
//     holds_credits) or help_filed: the server's words;
//   503 / a network error: try again, with the form kept.
// Nothing is ever charged, so there is no checkout and no price. Every word
// is the studio's corp_promo block (`copy`) or the server's answer. The
// browser Lead shares the server's event id so Meta counts one.
import { useState } from 'react'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath } from '@/lib/meta-pixel-paths'
import { isValidMobileNumber } from '@/lib/phone-validate'
import TrialTermsTick from './TrialTermsTick'

const CLAIM_PATH = '/api/public/corp-claims'
const inputCls = 'w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 focus:outline-none focus:border-white/50'
const card = 'w-full max-w-lg rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl px-6 py-8 md:px-8'

function utmFromUrl() {
  try {
    const p = new URLSearchParams(window.location.search)
    const out = {}
    for (const k of ['utm_source', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid']) {
      const v = p.get(k)
      if (v) out[k] = v.slice(0, k === 'fbclid' ? 500 : 200)
    }
    const fbp = document.cookie.match(/(?:^|;\s*)_fbp=([^;]+)/)
    if (fbp) out.fbp = decodeURIComponent(fbp[1]).slice(0, 100)
    return out
  } catch { return {} }
}

/**
 * @param {{ promoKey: string|null, copy: object, terms: object|null }} props
 *   promoKey null ⇒ no live promo: the card shows copy.unavailable_text.
 */
export default function CorpPromoFunnel({ promoKey, copy, terms }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { kind: 'granted'|'message', title?, message }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  if (!promoKey) {
    return <div className={`${card} text-center`}><p className="text-white/80">{copy.unavailable_text}</p></div>
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    if (!isValidMobileNumber(form.phone.trim())) { setError('Enter a valid mobile number.'); return }
    if (terms && !termsAccepted) { setError(terms.required_message || 'Please tick to accept the terms and waiver.'); return }
    setSubmitting(true)
    const leadEventId = newLeadEventId()
    try {
      const visit = readVisitOrigin()
      const res = await fetch(CLAIM_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promo: promoKey,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          terms_accepted: termsAccepted,
          attribution: utmFromUrl(),
          lead_event_id: leadEventId,
          ...(visit ? { visit } : {}),
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.status >= 500 || (!res.ok && !j.code)) { setError(j.error || 'Something went wrong on our side. Please try again in a moment.'); return }
      if (j.code === 'terms_required' || (res.status === 400 && j.error)) { setError(j.error); return }
      fireBrowserLead({
        pixelIds: metaPixelIdsForPath(window.location.pathname),
        eventId: leadEventId,
        userData: pixelUserData({ email: form.email, phone: form.phone, firstName: form.first_name, lastName: form.last_name }),
        contentName: promoKey,
      })
      if (j.success) setResult({ kind: 'granted', title: j.data?.title || copy.done_title, message: j.data?.message || '' })
      else setResult({ kind: 'message', message: j.error || copy.help_text })
    } catch {
      setError('Something went wrong on our side. Please try again in a moment.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <div className={`${card} text-center`} role="status">
        {result.kind === 'granted' && <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{result.title}</p>}
        <p className="text-white/80">{result.message}</p>
      </div>
    )
  }

  return (
    <div className={card}>
      {copy.title && <p className="font-display font-extrabold uppercase text-3xl md:text-4xl leading-tight text-white text-center mb-6">{copy.title}</p>}
      <div className="rounded-2xl bg-white text-black p-6 mb-6">
        {copy.eyebrow && <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/45 mb-2">{copy.eyebrow}</p>}
        <h1 className="font-display font-extrabold uppercase text-2xl leading-tight">{copy.heading}</h1>
        {copy.subhead && <p className="mt-3 text-sm text-black/70">{copy.subhead}</p>}
        {copy.ticks.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {copy.ticks.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className="mt-0.5 inline-block h-4 w-4 rounded-full bg-black text-white text-[10px] leading-4 text-center">✓</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={submit} className="space-y-3" aria-label="Your details">
        <div className="grid grid-cols-2 gap-3">
          <input className={inputCls} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" aria-label="First name" />
          <input className={inputCls} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" aria-label="Last name" />
        </div>
        <input className={inputCls} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" aria-label="Email" />
        <input className={inputCls} type="tel" placeholder="Mobile" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" aria-label="Mobile" />
        <label className="flex items-start gap-2.5 text-xs text-white/65 pt-1">
          <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-white" />
          <span>{copy.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
        </label>
        {terms && <TrialTermsTick terms={terms} checked={termsAccepted} onChange={setTermsAccepted} />}
        {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} className="lp-btn w-full disabled:opacity-50">
          {submitting ? 'One moment…' : copy.cta_label}
        </button>
        <p className="text-center text-[11px] text-white/45">Free. No card, nothing to pay.</p>
      </form>
    </div>
  )
}

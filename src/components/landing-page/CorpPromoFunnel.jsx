'use client'

// CorpPromoFunnel — CORPPROMO.1: the visitor's side of a /corp promo, in the
// /trial card's look (TRIALFIRST.1: the one white card, `./trial-card`).
// The form (details, consent, un1t.online's terms tick) →
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
import { metaPixelIdsForPath, pageLocationIdFromDocument } from '@/lib/meta-pixel-paths'
import { isValidMobileNumber } from '@/lib/phone-validate'
import TrialTermsTick from './TrialTermsTick'
import { TRIAL_CARD, TRIAL_INPUT, TRIAL_BTN, TRIAL_MUTED, TRIAL_FINE, TRIAL_ERROR, TRIAL_LINK } from './trial-card'
import { customerErrorText } from '@/lib/page-request-errors'

const CLAIM_PATH = '/api/public/corp-claims'

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
 * @param {{ promoKey: string|null, copy: object, terms: object|null, page?: string|null, studio?: string|null }} props
 *   promoKey null ⇒ no live promo: the card shows copy.unavailable_text.
 *   PAGES.1 — with `page` (the [slug] route passes the page's slug, and
 *   `studio` its studio's public path) the claim names `{ page, studio }` and
 *   the server takes the promo from the page's studio row (the `promo` sent
 *   alongside must name that same promo); without it the claim names the
 *   promo alone, as before.
 */
export default function CorpPromoFunnel({ promoKey, copy, terms, page = null, studio = null }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { kind: 'granted'|'message', title?, message }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  if (!promoKey) {
    return <div className={`${TRIAL_CARD} text-center`}><p className="text-black/80">{copy.unavailable_text}</p></div>
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
          ...(page ? { page, ...(studio ? { studio } : {}) } : {}),
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
      if (res.status >= 500 || (!res.ok && !j.code)) { setError(customerErrorText(j.error, 'Something went wrong on our side. Please try again in a moment.')); return }
      if (j.code === 'terms_required' || (res.status === 400 && j.error)) { setError(customerErrorText(j.error, 'Something went wrong on our side. Please try again in a moment.')); return }
      fireBrowserLead({
        pixelIds: metaPixelIdsForPath(window.location.pathname, { primaryLocationId: pageLocationIdFromDocument() }),
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
      <div className={`${TRIAL_CARD} text-center`} role="status">
        {result.kind === 'granted' && <p className="font-display font-extrabold text-3xl text-black mb-3">{result.title}</p>}
        <p className="text-black/80">{result.message}</p>
      </div>
    )
  }

  return (
    <div className={TRIAL_CARD}>
      {copy.title && <p className="font-display font-extrabold text-3xl md:text-4xl leading-tight text-black text-center mb-6">{copy.title}</p>}
      <div className="mb-6">
        {copy.eyebrow && <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/50 mb-2">{copy.eyebrow}</p>}
        <h1 className="font-display font-extrabold text-2xl leading-tight">{copy.heading}</h1>
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
        <div className="grid grid-cols-2 gap-4">
          <input className={TRIAL_INPUT} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" aria-label="First name" />
          <input className={TRIAL_INPUT} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" aria-label="Last name" />
        </div>
        <input className={TRIAL_INPUT} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" aria-label="Email" />
        <input className={TRIAL_INPUT} type="tel" placeholder="Mobile" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" aria-label="Mobile" />
        <label className={`flex items-start gap-2.5 text-xs pt-1 ${TRIAL_MUTED}`}>
          <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-black" />
          <span>{copy.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className={TRIAL_LINK}>Privacy</a></span>
        </label>
        {terms && <TrialTermsTick terms={terms} checked={termsAccepted} onChange={setTermsAccepted} />}
        {error && <p className={TRIAL_ERROR} role="alert">{error}</p>}
        <button type="submit" disabled={submitting} className={TRIAL_BTN}>
          {submitting ? 'One moment…' : copy.cta_label}
        </button>
        <p className={TRIAL_FINE}>Free. No card, nothing to pay.</p>
      </form>
    </div>
  )
}

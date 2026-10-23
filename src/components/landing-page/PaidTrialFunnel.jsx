'use client'

// PaidTrialFunnel — PAIDTRIAL.1: the buyer's side of the paid trial product
// (/trial). Three steps in one frosted card: the price panel with the form
// (details → POST /api/public/trial-purchases), the embedded checkout
// (ClassFunnelCheckout against the trial status route), then done. A return
// from a redirect-flow payment (?purchase=<id>) resumes in confirming mode
// and polls the status route, exactly like the offers page.
//
// What it tells Meta (no-ops without consent / fbq): the browser Lead at the
// POST, sharing the server's event id so Meta counts one, and (TRIALCHECKOUT.1)
// an InitiateCheckout at the same moment with the price, sharing
// `trialcheckout-<lead id>` with the server's copy: the Sales campaign's ad set
// optimises on it, since Meta's Sales objective cannot optimise on Lead; the
// browser Purchase on paid, sharing `trialpurchase-<id>` with the server's
// CAPI Purchase for the same reason. Funnel steps go out as custom `trial_*`
// events for drop-off diagnostics, never as optimisation events.
import { useEffect, useRef, useState } from 'react'
import { trackFunnelStep } from '@/lib/funnel-track'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead, fireBrowserInitiateCheckout, checkoutEventIdFor } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath } from '@/lib/meta-pixel-paths'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { formatTrialPrice, trialTicks } from '@/lib/paid-trial'
import ClassFunnelCheckout from './ClassFunnelCheckout'

const STATUS_PATH = '/api/public/trial-purchases'
const inputCls = 'w-full bg-white/[0.06] border border-white/15 rounded-xl px-4 py-3.5 text-base text-white placeholder-white/40 focus:outline-none focus:border-white/50'

function readFbpCookie() {
  try {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(/(?:^|;\s*)_fbp=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

function fireBrowserPurchase({ purchaseId, amountCents, currency, contentName }) {
  try {
    if (typeof window === 'undefined' || typeof window.fbq !== 'function') return
    window.fbq('track', 'Purchase', { value: (amountCents || 0) / 100, currency: currency || 'EUR', content_name: contentName }, { eventID: `trialpurchase-${purchaseId}` })
  } catch { /* pixel not loaded / blocked */ }
}

export default function PaidTrialFunnel({ block, publicPath = 'stillorgan', resumePurchaseId = null, sellable = true }) {
  const [step, setStep] = useState(resumePurchaseId ? 'confirming' : 'form') // form | payment | confirming | done
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [payment, setPayment] = useState(null) // { purchaseId, checkout, amount_cents, currency, product_name }
  const [done, setDone] = useState(null) // { state: 'paid'|'granted' }
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const attributionRef = useRef(null)
  const purchaseIdRef = useRef(resumePurchaseId)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const price = formatTrialPrice(block.price_cents, block.currency)
  const ticks = trialTicks(block)

  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      attributionRef.current = {
        utm_campaign: p.get('utm_campaign') || undefined,
        utm_content: p.get('utm_content') || undefined,
        utm_term: p.get('utm_term') || undefined,
        meta_ad_id: p.get('meta_ad_id') || p.get('ad_id') || undefined,
        fbclid: p.get('fbclid') || undefined,
      }
    } catch { /* never block the page */ }
    trackFunnelStep('trial_view')
  }, [])

  function buildAttribution() {
    const p = attributionRef.current || {}
    const hasSignal = p.meta_ad_id || p.utm_campaign || p.utm_content || p.utm_term || p.fbclid
    const fbp = readFbpCookie()
    if (!hasSignal && !fbp) return undefined
    return {
      ...(hasSignal ? { utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term, ad_provider: 'meta', ad_external_id: p.meta_ad_id, fbclid: p.fbclid } : {}),
      ...(fbp ? { fbp } : {}),
    }
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    if (!isValidMobileNumber(form.phone)) { setError('Please enter a valid mobile number (e.g. 087 123 4567).'); return }
    setSubmitting(true)
    const leadEventId = newLeadEventId()
    try {
      const r = await fetch('/api/public/trial-purchases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: publicPath,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          attribution: buildAttribution(),
          visit: readVisitOrigin() || undefined,
          lead_event_id: leadEventId,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || 'Something went wrong. Please try again.'); return
      }
      fireBrowserLead({
        pixelIds: typeof window !== 'undefined' ? metaPixelIdsForPath(window.location.pathname) : [],
        eventId: leadEventId,
        userData: pixelUserData({ email: form.email, phone: form.phone, firstName: form.first_name, lastName: form.last_name }),
        contentName: j.data?.product_name,
      })
      fireBrowserInitiateCheckout({
        eventId: checkoutEventIdFor(leadEventId),
        value: (j.data?.amount_cents ?? block.price_cents ?? 0) / 100,
        currency: j.data?.currency || block.currency,
        contentName: j.data?.product_name,
      })
      trackFunnelStep('trial_checkout_view')
      purchaseIdRef.current = j.data.purchaseId
      setPayment(j.data)
      setStep('payment')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function onPaid() {
    const p = payment || {}
    fireBrowserPurchase({ purchaseId: purchaseIdRef.current, amountCents: p.amount_cents ?? block.price_cents, currency: p.currency || block.currency, contentName: p.product_name || block.product_name })
    trackFunnelStep('trial_paid')
    setDone({ state: 'paid' })
    setStep('done')
  }

  // Confirming (redirect return) and done: poll until the plan is on the
  // account so the screen can say so honestly. Stops on granted or failed.
  useEffect(() => {
    if (step !== 'confirming' && step !== 'done') return
    const id = purchaseIdRef.current
    if (!id) { setStep('form'); return }
    let stopped = false
    let ticks = 0
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`${STATUS_PATH}/${id}`, { cache: 'no-store' })
        if (r.status === 404) { if (!stopped) { setStep('form'); setError('We could not find that purchase. Please start again.') } ; return }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (stopped || !d) return
        if (d.state === 'granted') { setDone({ state: 'granted' }); setStep('done'); return }
        if (d.state === 'failed') { setStep('form'); setError('That payment did not go through. Nothing was charged; please try again.'); return }
        if (d.state === 'paid' && step === 'confirming') {
          fireBrowserPurchase({ purchaseId: id, amountCents: d.amount_cents, currency: d.currency, contentName: d.product_name })
          trackFunnelStep('trial_paid')
          setDone({ state: 'paid' }); setStep('done'); return
        }
      } catch { /* keep polling */ }
      // Give the grant up to ~2 minutes of polling, then leave the paid screen as is.
      if (!stopped && ++ticks < 40) setTimeout(tick, 3000)
    }
    const t = setTimeout(tick, step === 'confirming' ? 300 : 3000)
    return () => { stopped = true; clearTimeout(t) }
  }, [step])

  const card = 'w-full max-w-lg rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl px-6 py-8 md:px-8'

  if (!sellable) {
    return (
      <div className={card}>
        <p className="font-display font-extrabold uppercase text-2xl text-white mb-2">{block.heading || 'Trial'}</p>
        <p className="text-white/70">The trial is not available online right now. Message us on WhatsApp or drop into the studio and we will sort you out.</p>
      </div>
    )
  }

  if (step === 'confirming') {
    return (
      <div className={`${card} text-center`}>
        <p className="font-display font-extrabold uppercase text-2xl text-white mb-2">Confirming your payment</p>
        <p className="text-white/70">One moment while we check with the bank.</p>
      </div>
    )
  }

  if (step === 'done') {
    const granted = done?.state === 'granted'
    return (
      <div className={`${card} text-center`}>
        <p className="font-display font-extrabold uppercase text-3xl text-white mb-3">{granted ? (block.done_title || "You're in") : 'Payment received'}</p>
        <p className="text-white/70">
          {granted
            ? (block.done_body || 'Your trial is on your account. Check your email for how to book your first class.')
            : 'Thanks, your payment is in. We are setting the trial up on your account now; this usually takes under a minute. Your confirmation email has the details.'}
        </p>
      </div>
    )
  }

  if (step === 'payment' && payment) {
    return (
      <div className={card}>
        <ClassFunnelCheckout
          paymentId={payment.purchaseId}
          checkout={payment.checkout}
          priceLabel={`${payment.product_name || block.product_name} · ${formatTrialPrice(payment.amount_cents, payment.currency)}`}
          statusPath={STATUS_PATH}
          onPaid={onPaid}
          onCancel={() => { setStep('form') }}
        />
      </div>
    )
  }

  return (
    <div className={card}>
      {/* The price panel: inverted white on the dark card so the price is the
          first thing the eye lands on (the Hatch foundation-offer lesson). */}
      <div className="rounded-2xl bg-white text-black p-6 mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            {block.eyebrow && <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/45 mb-2">{block.eyebrow}</p>}
            <h1 className="font-display font-extrabold uppercase text-2xl leading-tight">{block.heading}</h1>
          </div>
          <div className="text-right shrink-0">
            <div className="font-display font-extrabold text-4xl leading-none">{price}</div>
            <div className="text-xs text-black/55 mt-1">once, for {block.duration_days || 14} days</div>
          </div>
        </div>
        {block.subhead && <p className="mt-3 text-sm text-black/70">{block.subhead}</p>}
        {ticks.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {ticks.map((t) => (
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
        <input className={inputCls} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" aria-label="Phone" />
        <label className="flex items-start gap-2.5 text-xs text-white/65 pt-1">
          <input type="checkbox" checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-white" />
          <span>{block.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className="underline">Privacy</a></span>
        </label>
        {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} className="lp-btn w-full disabled:opacity-50">
          {submitting ? 'One moment…' : `${block.cta_label || 'Start my trial'} · ${price}`}
        </button>
        <p className="text-center text-[11px] text-white/45">Secure payment. You are charged {price} once; nothing renews.</p>
      </form>
    </div>
  )
}

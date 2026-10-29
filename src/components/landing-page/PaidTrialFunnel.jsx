'use client'

// PaidTrialFunnel — PAIDTRIAL.1 / TRIALSTUDIO.10: the buyer's side of the paid
// trial (/trial), in one white card (TRIALFIRST.1: `./trial-card`, the look the
// studio pages' heroes share). The buyer chooses a studio first
// (TrialStudioPicker; `?studio=` preselects a sellable one), then the price
// panel with the form (details → POST /api/public/trial-purchases with the
// studio). Then, by studio:
//   Stillorgan: the embedded checkout (ClassFunnelCheckout against the trial
//     status route), then done.
//   Hatch Street: un1t.online's terms tick on the form, and the browser goes
//     to un1t.online's own hosted checkout (`redirect_url`). The return
//     (?purchase=<id>&studio=hatch) confirms off the status route; the cron
//     settles the row off the un1t.online mirror, so after the poll budget the
//     screen says the payment is being confirmed (the block's pending_body),
//     never "it's on your account" before it is. `?cancelled=1` is back to
//     the form with the studio chosen.
//   A refusal (trial_used at Stillorgan, active_member at Hatch) shows the
//   studio's message and one help button, which files a staff card
//   (POST /api/public/trial-purchases/help) and shows its thanks. help_filed
//   (the server already filed one) goes straight to the thanks.
// Every studio-specific word is the studio's paid_trial block or the server's
// answer.
//
// TRIALFIRST.1, for a studio page's hero: given ONE studio there is no
// "Change studio" (and an unsellable one shows the picker's disabled tile
// with the not-available line); `returnPath` goes to the POST as
// `return_path`, so a checkout comes back to the page it started on (the
// server allows /trial, /stillorgan, /hatch-street); `preview` is the
// operator's editor: the form renders disabled, posts nothing, tracks nothing.
//
// What it tells Meta (no-ops without consent / fbq): the browser Lead at the
// POST, sharing the server's event id so Meta counts one, and (TRIALCHECKOUT.1)
// an InitiateCheckout at the same moment with the price, sharing
// `trialcheckout-<lead id>` with the server's copy: the Sales campaign's ad set
// optimises on it, since Meta's Sales objective cannot optimise on Lead. A
// refused buyer was still captured, so gets the Lead alone. The browser
// Purchase fires once on paid (Stillorgan) or granted (both), sharing
// `trialpurchase-<id>` with the server's CAPI Purchase for the same reason.
// Funnel steps go out as custom `trial_*` events for drop-off diagnostics,
// never as optimisation events.
import { useEffect, useRef, useState } from 'react'
import { trackFunnelStep } from '@/lib/funnel-track'
import { readVisitOrigin } from '@/lib/visit-origin'
import { newLeadEventId, pixelUserData, fireBrowserLead, fireBrowserInitiateCheckout, checkoutEventIdFor } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath } from '@/lib/meta-pixel-paths'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { formatTrialPrice, trialTicks, PAID_TRIAL_PENDING_BODY } from '@/lib/paid-trial'
import ClassFunnelCheckout from './ClassFunnelCheckout'
import TrialStudioPicker from './TrialStudioPicker'
import TrialTermsTick from './TrialTermsTick'
import { TRIAL_CARD, TRIAL_INPUT, TRIAL_BTN, TRIAL_MUTED, TRIAL_FINE, TRIAL_ERROR, TRIAL_LINK } from './trial-card'

const STATUS_PATH = '/api/public/trial-purchases'
const HELP_PATH = '/api/public/trial-purchases/help'
const REFUSALS = new Set(['trial_used', 'active_member'])

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

/**
 * @param {{ studios: Array<{ key: 'stillorgan'|'hatch', label: string, sellable: boolean, block: object,
 *   priceCents: number|null, currency: string, durationDays: number, productName: string }>,
 *   initialStudio?: string|null, resumePurchaseId?: string|null, cancelled?: boolean, hatchTerms?: object|null,
 *   returnPath?: string, preview?: boolean }} props
 */
export default function PaidTrialFunnel({ studios = [], initialStudio = null, resumePurchaseId = null, cancelled = false, hatchTerms = null, returnPath = '/trial', preview = false }) {
  const list = Array.isArray(studios) ? studios : []
  const byKey = (k) => list.find((s) => s.key === k) || null
  const resuming = Boolean(resumePurchaseId) && !cancelled
  const preselected = byKey(initialStudio)?.sellable ? initialStudio : null
  // A return without ?studio= is a Stillorgan redirect-flow payment (the only kind before TRIALSTUDIO).
  const [studioKey, setStudioKey] = useState(resuming ? (initialStudio === 'hatch' ? 'hatch' : 'stillorgan') : preselected)
  const [step, setStep] = useState(resuming ? 'confirming' : (preselected ? 'form' : 'choose')) // choose | form | payment | confirming | done | refused | help_sent
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', consent: true })
  const [payment, setPayment] = useState(null) // { purchaseId, checkout, amount_cents, currency, product_name }
  const [done, setDone] = useState(null) // { state: 'paid'|'granted'|'pending' }
  const [refusal, setRefusal] = useState(null) // { message, ctaLabel }
  const [helpMessage, setHelpMessage] = useState('')
  const [termsOverride, setTermsOverride] = useState(null)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const attributionRef = useRef(null)
  const purchaseIdRef = useRef(resuming ? resumePurchaseId : null)
  const purchaseFiredRef = useRef(false)

  const studio = byKey(studioKey)
  const block = studio?.block || {}
  const isHatch = studioKey === 'hatch'
  // un1t.online's terms tick: Hatch only; the page's copy, or the server's when it asked for it.
  const terms = isHatch ? (termsOverride || (hatchTerms?.required === true ? hatchTerms : null)) : null
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const price = formatTrialPrice(studio?.priceCents, studio?.currency)
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
    if (!preview) trackFunnelStep('trial_view') // the editor's preview tracks nothing
  }, [preview])

  // Back from un1t.online's checkout restores this page from the back-forward
  // cache with the button still on "One moment…": give it back.
  useEffect(() => {
    const onShow = (e) => { if (e.persisted) setSubmitting(false) }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
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

  function choose(key) {
    if (!byKey(key)?.sellable) return
    if (key !== studioKey) { setTermsOverride(null); setTermsAccepted(false) }
    setStudioKey(key)
    setError(null)
    if (!preview) trackFunnelStep('trial_studio_chosen', { studio: key })
    setStep('form')
  }

  function firePurchaseOnce({ purchaseId, amountCents, currency, contentName }) {
    if (purchaseFiredRef.current) return
    purchaseFiredRef.current = true
    fireBrowserPurchase({ purchaseId, amountCents, currency, contentName })
    trackFunnelStep('trial_paid', { studio: studioKey })
  }

  async function submit(e) {
    e.preventDefault()
    if (preview) return
    setError(null)
    if (!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.phone.trim() || !form.consent) {
      setError('Please complete every field and tick consent.'); return
    }
    if (!isValidMobileNumber(form.phone)) { setError('Please enter a valid mobile number (e.g. 087 123 4567).'); return }
    if (terms && !termsAccepted) { setError(terms.required_message || 'Please tick to accept the terms and waiver.'); return }
    setSubmitting(true)
    let leaving = false
    const leadEventId = newLeadEventId()
    const fireLead = (contentName) => fireBrowserLead({
      pixelIds: typeof window !== 'undefined' ? metaPixelIdsForPath(window.location.pathname) : [],
      eventId: leadEventId,
      userData: pixelUserData({ email: form.email, phone: form.phone, firstName: form.first_name, lastName: form.last_name }),
      contentName,
    })
    try {
      const r = await fetch(STATUS_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studio: studioKey,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(), consent: form.consent,
          ...(terms ? { terms_accepted: termsAccepted } : {}),
          attribution: buildAttribution(),
          visit: readVisitOrigin() || undefined,
          lead_event_id: leadEventId,
          return_path: returnPath,
        }),
      })
      const j = await r.json().catch(() => ({}))
      // The studio needs un1t.online's tick and this page did not know: show it from the answer.
      if (j.code === 'terms_required' && j.terms?.required === true) {
        setTermsOverride(j.terms)
        setError(j.error || j.terms.required_message || null); return
      }
      // A refusal is a state, not an error. The server captured the lead and sent its Lead.
      if (j.success === false && (REFUSALS.has(j.code) || j.code === 'help_filed')) {
        fireLead(studio?.productName)
        trackFunnelStep('trial_refused', { studio: studioKey, code: j.code })
        if (j.code === 'help_filed') {
          trackFunnelStep('trial_help_sent', { studio: studioKey })
          setHelpMessage(j.error || block.help_sent_text)
          setStep('help_sent'); return
        }
        setRefusal({
          message: j.error || (j.code === 'trial_used' ? block.trial_used_text : block.active_member_text),
          ctaLabel: j.help?.cta_label || block.help_cta_label,
        })
        setStep('refused'); return
      }
      if (!r.ok || j.success === false || !j.data) {
        setError(j.error || 'Something went wrong. Please try again.'); return
      }
      fireLead(j.data.product_name)
      fireBrowserInitiateCheckout({
        eventId: checkoutEventIdFor(leadEventId),
        value: (j.data.amount_cents ?? studio?.priceCents ?? 0) / 100,
        currency: j.data.currency || studio?.currency,
        contentName: j.data.product_name,
      })
      trackFunnelStep('trial_checkout_view', { studio: studioKey })
      purchaseIdRef.current = j.data.purchaseId
      if (j.data.redirect_url) {
        // Hatch Street: un1t.online takes the money on its own checkout.
        trackFunnelStep('trial_hatch_redirect', { studio: studioKey })
        leaving = true
        window.location.assign(j.data.redirect_url)
        return
      }
      setPayment(j.data)
      setStep('payment')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      if (!leaving) setSubmitting(false)
    }
  }

  async function askForHelp() {
    setError(null)
    setSubmitting(true)
    try {
      const r = await fetch(HELP_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studio: studioKey,
          first_name: form.first_name.trim(), last_name: form.last_name.trim(),
          email: form.email.trim(), phone: form.phone.trim(),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) { setError(j.error || 'Something went wrong. Please try again.'); return }
      trackFunnelStep('trial_help_sent', { studio: studioKey })
      setHelpMessage(j.data?.message || block.help_sent_text)
      setStep('help_sent')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function onPaid() {
    const p = payment || {}
    firePurchaseOnce({ purchaseId: purchaseIdRef.current, amountCents: p.amount_cents ?? studio?.priceCents, currency: p.currency || studio?.currency, contentName: p.product_name || studio?.productName })
    setDone({ state: 'paid' })
    setStep('done')
  }

  // Confirming (a return from a checkout) and done: poll until the trial is
  // on the account so the screen can say so honestly. Stops on granted,
  // failed, expired or help. A Hatch row stays pending until the cron
  // settles it off the mirror: after the budget the screen says it is being
  // confirmed, and the done screen keeps listening for the grant.
  useEffect(() => {
    if (step !== 'confirming' && step !== 'done') return
    const id = purchaseIdRef.current
    // Back to the start with a reason: the form, or the choice when the studio is no longer for sale.
    const restart = (msg) => { setStep(studio?.sellable ? 'form' : 'choose'); setError(msg) }
    if (!id) { restart(null); return }
    let stopped = false
    let polls = 0
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`${STATUS_PATH}/${id}`, { cache: 'no-store' })
        if (r.status === 404) { if (!stopped) restart('We could not find that purchase. Please start again.'); return }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (stopped || !d) return
        if (d.state === 'granted') {
          firePurchaseOnce({ purchaseId: id, amountCents: d.amount_cents, currency: d.currency, contentName: d.product_name })
          setDone({ state: 'granted' }); setStep('done'); return
        }
        if (d.state === 'failed') { restart('That payment did not go through. Nothing was charged; please try again.'); return }
        if (d.state === 'expired') { restart('That checkout expired. Nothing was charged; please start again.'); return }
        if (d.state === 'help') { setHelpMessage(block.help_sent_text); setStep('help_sent'); return }
        if (d.state === 'paid' && step === 'confirming') {
          firePurchaseOnce({ purchaseId: id, amountCents: d.amount_cents, currency: d.currency, contentName: d.product_name })
          setDone({ state: 'paid' }); setStep('done'); return
        }
      } catch { /* keep polling */ }
      if (stopped) return
      // Give the grant up to ~2 minutes of polling, then leave the screen as is
      // (a Hatch purchase moves to its "being confirmed" screen).
      if (++polls < 40) setTimeout(tick, 3000)
      else if (step === 'confirming' && isHatch) { setDone({ state: 'pending' }); setStep('done') }
    }
    const t = setTimeout(tick, step === 'confirming' ? 300 : 3000)
    return () => { stopped = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the studio and its block are fixed while polling; re-arming on them would double the polls
  }, [step])

  if (step === 'choose') {
    return (
      <div className={TRIAL_CARD}>
        <TrialStudioPicker studios={list} onChoose={choose} />
        {error && <p className={`mt-4 ${TRIAL_ERROR}`} role="alert">{error}</p>}
        {!list.some((s) => s.sellable) && (
          <p className={`mt-4 ${TRIAL_MUTED}`}>The trial is not available online right now. Message us on WhatsApp or drop into the studio and we will sort you out.</p>
        )}
      </div>
    )
  }

  if (step === 'confirming') {
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="font-display font-extrabold text-2xl text-black mb-2">Confirming your payment</p>
        <p className={TRIAL_MUTED}>{isHatch ? (block.pending_body || PAID_TRIAL_PENDING_BODY) : 'One moment while we check with the bank.'}</p>
      </div>
    )
  }

  if (step === 'done') {
    const state = done?.state
    const title = state === 'granted' ? (block.done_title || "You're in") : state === 'pending' ? 'Almost there' : 'Payment received'
    const body = state === 'granted'
      ? (block.done_body || 'Your trial is on your account. Check your email for how to book your first class.')
      : state === 'pending'
        ? (block.pending_body || PAID_TRIAL_PENDING_BODY)
        : 'Thanks, your payment is in. We are setting the trial up on your account now; this usually takes under a minute. Your confirmation email has the details.'
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="font-display font-extrabold text-3xl text-black mb-3">{title}</p>
        <p className={TRIAL_MUTED}>{body}</p>
      </div>
    )
  }

  if (step === 'help_sent') {
    return (
      <div className={`${TRIAL_CARD} text-center`}>
        <p className="text-black/80" role="status">{helpMessage}</p>
      </div>
    )
  }

  if (step === 'refused' && refusal) {
    return (
      <div className={TRIAL_CARD}>
        <p className="text-black/80 mb-5">{refusal.message}</p>
        {error && <p className={`${TRIAL_ERROR} mb-3`} role="alert">{error}</p>}
        <button type="button" onClick={askForHelp} disabled={submitting} className={TRIAL_BTN}>
          {submitting ? 'One moment…' : refusal.ctaLabel}
        </button>
      </div>
    )
  }

  if (step === 'payment' && payment) {
    return (
      <div className={TRIAL_CARD}>
        <ClassFunnelCheckout
          tone="light"
          paymentId={payment.purchaseId}
          checkout={payment.checkout}
          priceLabel={`${payment.product_name || studio?.productName} · ${formatTrialPrice(payment.amount_cents, payment.currency)}`}
          statusPath={STATUS_PATH}
          onPaid={onPaid}
          onCancel={() => { setStep('form') }}
        />
      </div>
    )
  }

  return (
    <div className={TRIAL_CARD}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className={`text-xs uppercase tracking-[0.25em] font-semibold ${TRIAL_MUTED}`}>{studio?.label}</p>
        {/* One studio (a studio page's hero) has nothing to change to. */}
        {list.length > 1 && (
          <button type="button" disabled={preview} onClick={() => { setError(null); setStep('choose') }} className={`text-xs ${TRIAL_MUTED} ${TRIAL_LINK}`}>
            Change studio
          </button>
        )}
      </div>
      {/* The price region: the heading and the price first, where the eye
          lands (the Hatch foundation-offer lesson). */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            {block.eyebrow && <p className="text-[11px] uppercase tracking-[0.35em] font-semibold text-black/50 mb-2">{block.eyebrow}</p>}
            <h1 className="font-display font-extrabold text-2xl leading-tight">{block.heading}</h1>
          </div>
          <div className="text-right shrink-0">
            <div className="font-display font-extrabold text-4xl leading-none">{price}</div>
            <div className="text-xs text-black/55 mt-1">once, for {studio?.durationDays || 14} days</div>
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
        <div className="grid grid-cols-2 gap-4">
          <input className={TRIAL_INPUT} disabled={preview} placeholder="First name" value={form.first_name} onChange={set('first_name')} maxLength={120} autoComplete="given-name" aria-label="First name" />
          <input className={TRIAL_INPUT} disabled={preview} placeholder="Last name" value={form.last_name} onChange={set('last_name')} maxLength={120} autoComplete="family-name" aria-label="Last name" />
        </div>
        <input className={TRIAL_INPUT} disabled={preview} type="email" placeholder="Email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" aria-label="Email" />
        <input className={TRIAL_INPUT} disabled={preview} type="tel" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={50} autoComplete="tel" aria-label="Phone" />
        <label className={`flex items-start gap-2.5 text-xs pt-1 ${TRIAL_MUTED}`}>
          <input type="checkbox" disabled={preview} checked={form.consent} onChange={set('consent')} className="mt-0.5 w-4 h-4 accent-black" />
          <span>{block.consent_label} <a href="/privacy" target="_blank" rel="noreferrer" className={TRIAL_LINK}>Privacy</a></span>
        </label>
        {terms && <TrialTermsTick terms={terms} checked={termsAccepted} onChange={setTermsAccepted} disabled={preview} />}
        {error && <p className={TRIAL_ERROR} role="alert">{error}</p>}
        <button type="submit" disabled={preview || submitting} className={TRIAL_BTN}>
          {submitting ? 'One moment…' : `${block.cta_label || 'Start my trial'} · ${price}`}
        </button>
        <p className={TRIAL_FINE}>Secure payment. You are charged {price} once; nothing renews.</p>
      </form>
    </div>
  )
}

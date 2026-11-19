'use client'

// OfferCheckout — buyer form + checkout for one sale offer (OFFERS.7,
// per studio since BLACKFRIDAY.3). POST /api/public/offers/[studio]/[slug]/checkout
// creates the purchase server-side (price from sale_offers, never from here).
//   * provider 'revolut' (Stillorgan): the Revolut SDK mounts against the
//     returned token; a status poll on /api/public/offer-purchases/[id] is the
//     paid fallback for redirect-style payment methods.
//   * provider 'un1t_online' (Hatch Street): the browser goes to un1t.online's
//     hosted checkout (data.checkout.url). The form carries un1t.online's
//     terms and waiver tick (`terms`, un1tTermsPayload's shape, as /trial
//     renders it); a 400 terms_required answer re-renders it from the reply;
//     a 202 help_filed answer (staff have the buyer's details) ends the form.
//   * cancelled (BLACKFRIDAY.9): the buyer came back from un1t.online's cancel
//     URL; the form shows with "Checkout cancelled. Nothing was charged.".
//   * Meta (OFFERTRACK.1): the checkout fires Lead and InitiateCheckout with
//     the ids the server sends its own copies under, and a Revolut payment
//     fires Purchase (`offerpurchase-<id>`, the server's id too). The ad
//     attribution from the landing URL (first touch) goes with the checkout.
// Every prop is serialisable: a function prop from the server page crashes
// the page in production.
import { useEffect, useRef, useState } from 'react'
import { firstTouchAttribution } from '@/lib/visit-origin'
import { readAttributionFromUrl, buildAttribution } from '@/lib/campaign-funnel-attribution'
import { newLeadEventId, pixelUserData, fireBrowserLead, fireBrowserInitiateCheckout } from '@/lib/meta-pixel-lead'
import { metaPixelIdsForPath } from '@/lib/meta-pixel-paths'
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'
import { termsLabelSegments } from '@/lib/un1t-online-funnel-copy'

function readFbpCookie() {
  try {
    if (typeof document === 'undefined') return null
    const m = document.cookie.match(/(?:^|;\s*)_fbp=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch { return null }
}

// OFFERTRACK.1 — the browser Purchase for a Revolut payment, under the id the
// server's copy uses, so Meta counts one. Never throws.
function fireOfferPurchase({ purchaseId, priceCents, currency, offerName }) {
  try {
    if (typeof window === 'undefined' || typeof window.fbq !== 'function' || !purchaseId) return
    window.fbq('track', 'Purchase', { value: (priceCents || 0) / 100, currency: currency || 'EUR', content_name: offerName }, { eventID: `offerpurchase-${purchaseId}` })
  } catch { /* pixel not loaded or blocked */ }
}

// OFFERSPOLISH.1 — the error line's id: the tick points at it while it is the
// thing in error, so a screen reader reads the reason with the control.
const ERROR_ID = 'ofr-error'

function TermsTick({ terms, checked, onChange, invalid = false, inputRef = null }) {
  return (
    <label htmlFor="ofr-terms" className="mt-6" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, lineHeight: 1.5, color: '#b5b5b5' }}>
      <input id="ofr-terms" name="terms_accepted" ref={inputRef} type="checkbox" required checked={checked} onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid ? 'true' : undefined} aria-describedby={invalid ? ERROR_ID : undefined}
        style={{ marginTop: 1, width: 20, height: 20, accentColor: '#ffffff', flexShrink: 0 }} />
      <span>
        {termsLabelSegments({ terms_label: terms.label, terms_link_label: terms.terms_link_label, waiver_link_label: terms.waiver_link_label })
          .map((seg, i) => (seg.link
            ? <a key={i} href={seg.link === 'terms' ? terms.terms_url : terms.waiver_url} target="_blank" rel="noreferrer" style={{ color: '#ffffff', textDecoration: 'underline' }}>{seg.text}</a>
            : <span key={i}>{seg.text}</span>))}
      </span>
    </label>
  )
}

export default function OfferCheckout({ studio, slug, priceLabel, provider = 'revolut', terms = null, resumePurchaseId = null, cancelled = false, soldOutLabel = 'Sold out', offerName = null, priceCents = null, currency = 'EUR' }) {
  const isUn1t = provider === 'un1t_online'
  // resumePurchaseId: set when Revolut redirected the buyer back after an
  // app-handoff payment (Revolut Pay on mobile) — start by confirming that
  // purchase instead of showing a fresh form.
  const [step, setStep] = useState(resumePurchaseId ? 'confirming' : 'form') // form | pay | confirming | paid | help
  const [helpMessage, setHelpMessage] = useState(null)
  const [fields, setFields] = useState({ name: '', email: '', phone: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Shown above the form until the buyer submits again.
  const [notice, setNotice] = useState(cancelled ? 'Checkout cancelled. Nothing was charged.' : null)
  const [session, setSession] = useState(null) // { purchaseId, token }
  const targetRef = useRef(null)
  const instanceRef = useRef(null)
  const paidRef = useRef(false)
  // The server's terms, when it asked for a tick this page did not know about.
  const [termsOverride, setTermsOverride] = useState(null)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const activeTerms = termsOverride || terms || null
  // True while the error on screen is "tick the terms": cleared by the tick.
  const [termsInvalid, setTermsInvalid] = useState(false)
  const termsRef = useRef(null)
  // The terms error is the one the buyer fixes on a control, so focus goes to
  // it. After the server asked for a tick the box may not be on screen yet,
  // hence the effect rather than a call in the handler.
  useEffect(() => { if (termsInvalid) termsRef.current?.focus() }, [termsInvalid])
  const acceptTerms = (v) => { setTermsAccepted(v); if (v) setTermsInvalid(false) }

  // OFFERTRACK.1 — first-touch ad attribution and the Lead's event id.
  const attributionRef = useRef(null)
  const leadEventIdRef = useRef(null)
  useEffect(() => {
    try { attributionRef.current = firstTouchAttribution(readAttributionFromUrl(window.location.search)) } catch { /* no attribution */ }
  }, [])
  const purchaseIdRef = useRef(resumePurchaseId)

  const markPaid = () => {
    if (paidRef.current) return
    paidRef.current = true
    fireOfferPurchase({ purchaseId: purchaseIdRef.current, priceCents, currency, offerName })
    setStep('paid')
  }

  const submit = async (e) => {
    e.preventDefault()
    if (activeTerms && !termsAccepted) {
      setError(activeTerms.required_message || 'Please tick to accept the terms and waiver.')
      setTermsInvalid(true)
      return
    }
    setBusy(true); setError(null); setNotice(null); setTermsInvalid(false)
    let leaving = false
    try {
      const r = await fetch(`/api/public/offers/${encodeURIComponent(studio)}/${encodeURIComponent(slug)}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          ...(activeTerms ? { terms_accepted: true } : {}),
          attribution: buildAttribution(attributionRef.current, readFbpCookie()),
          lead_event_id: (leadEventIdRef.current ||= newLeadEventId()),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 400 && j.code === 'terms_required' && j.terms?.required === true) {
        setTermsOverride(j.terms)
        setTermsAccepted(false)
        setError(j.error || j.terms.required_message || null)
        setTermsInvalid(true)
        return
      }
      // BLACKFRIDAY.4 — un1t.online's checkout could not be opened and staff
      // have the buyer's details: say so and stop, rather than inviting a
      // retry that would file a second help alert.
      if (r.status === 202 && j.code === 'help_filed') {
        setHelpMessage(j.error || 'The team has your details and will be in touch today.')
        setStep('help')
        return
      }
      // OFFERSTOCK.1 — the last one went while this form was open.
      if (r.status === 409 && j.code === 'sold_out') {
        setHelpMessage(j.error || null)
        setStep('sold_out')
        return
      }
      if (r.status === 410) throw new Error('The sale has ended.')
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not start checkout. Please try again.')
      // OFFERTRACK.1 — the checkout opened: Lead and InitiateCheckout, under
      // the ids the server's copies use.
      const leadId = leadEventIdRef.current
      fireBrowserLead({
        pixelIds: metaPixelIdsForPath(window.location.pathname),
        eventId: leadId,
        userData: pixelUserData({ email: fields.email, phone: fields.phone, firstName: fields.name.split(/\s+/)[0], lastName: fields.name.split(/\s+/).slice(1).join(' ') }),
        contentName: offerName || undefined,
      })
      fireBrowserInitiateCheckout({ eventId: `offercheckout-${leadId}`, value: (priceCents || 0) / 100, currency, contentName: offerName || undefined })
      purchaseIdRef.current = j.data?.purchaseId || purchaseIdRef.current
      if (j.data?.checkout?.provider === 'un1t_online') {
        if (!j.data.checkout.url) throw new Error('Could not start checkout. Please try again.')
        leaving = true
        window.location.assign(j.data.checkout.url)
        return
      }
      setSession({ purchaseId: j.data.purchaseId, token: j.data.checkout.token })
      setStep('pay')
    } catch (err) {
      setError(err.message)
    } finally {
      // Leaving for un1t.online: keep the button busy until the page goes.
      if (!leaving) setBusy(false)
    }
  }

  // Mount the Revolut embed once we hold an order token.
  useEffect(() => {
    if (step !== 'pay' || !session?.token) return
    if (!targetRef.current || instanceRef.current) return
    if (!revolutPublicKey()) { setError('Payment is not configured.'); return }
    let destroyed = false
    loadRevolutSdk(revolutMode())
      .then((RC) => {
        if (destroyed) return
        instanceRef.current = RC.embeddedCheckout({
          publicToken: revolutPublicKey(),
          mode: revolutMode(),
          locale: 'auto',
          target: targetRef.current,
          createOrder: async () => ({ publicId: session.token }),
          onSuccess: () => { if (!destroyed) markPaid() },
          onError: ({ error: err }) => { if (!destroyed) setError(err?.message || 'Payment failed. Please try again.') },
          onCancel: () => { if (!destroyed) setStep('form') },
        })
      })
      .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
    return () => {
      destroyed = true
      try { instanceRef.current?.destroy?.() } catch { /* SDK teardown is best-effort */ }
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, session])

  // Paid fallback poll (some methods never fire onSuccess inline), doubling
  // as the redirect-return confirmation loop. On a terminal failure while
  // confirming, fall back to the form with a message.
  useEffect(() => {
    // un1t.online settles its own payment: there is nothing here to poll.
    if (isUn1t) return
    const purchaseId = step === 'pay' ? session?.purchaseId : step === 'confirming' ? resumePurchaseId : null
    if (!purchaseId) return
    let stopped = false
    const tick = async () => {
      if (stopped || paidRef.current) return
      try {
        const r = await fetch(`/api/public/offer-purchases/${purchaseId}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!stopped && j?.data?.paid) { markPaid(); return }
        if (!stopped && step === 'confirming' && (j?.data?.state === 'failed' || j?.data?.state === 'cancelled')) {
          setError('The payment was not completed. You can try again below.')
          setStep('form')
          return
        }
      } catch { /* keep polling */ }
      if (!stopped) setTimeout(tick, 3000)
    }
    const t = setTimeout(tick, step === 'confirming' ? 300 : 3000)
    return () => { stopped = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, session])

  if (step === 'help') {
    return (
      <div className="text-center py-10">
        <p className="ofr-display text-2xl mb-4">We&rsquo;ll be in touch</p>
        <p className="text-sm" style={{ color: '#9a9a9a' }}>{helpMessage}</p>
      </div>
    )
  }

  if (step === 'sold_out') {
    return (
      <div className="text-center py-10" role="status">
        <p className="ofr-display text-2xl mb-4">{soldOutLabel}</p>
        {helpMessage && <p className="text-sm" style={{ color: '#9a9a9a' }}>{helpMessage}</p>}
      </div>
    )
  }

  if (step === 'confirming' && isUn1t) {
    return (
      <div className="text-center py-10">
        <p className="ofr-display text-2xl mb-4">Thanks</p>
        <p className="text-sm" style={{ color: '#9a9a9a' }}>
          Thanks, your payment is with un1t.online. We&rsquo;ll be in touch within 24 hours to add your bonus.
        </p>
      </div>
    )
  }

  if (step === 'confirming') {
    return (
      <div className="text-center py-10">
        <p className="ofr-display text-2xl mb-4">Confirming your payment…</p>
        <p className="text-sm" style={{ color: '#9a9a9a' }}>
          One moment. If you completed the payment in the Revolut app, this updates automatically.
        </p>
      </div>
    )
  }

  if (step === 'paid') {
    return (
      <div className="text-center py-10">
        <p className="ofr-display text-3xl mb-4">You&rsquo;re locked in</p>
        <p className="text-sm" style={{ color: '#9a9a9a' }}>
          Payment received. We&rsquo;ll be in touch within 24 hours to get you set up. A receipt is on its way to your email.
        </p>
      </div>
    )
  }

  if (step === 'pay') {
    return (
      <div>
        <p className="ofr-label mb-4">Secure checkout · {priceLabel}</p>
        {error && <p className="text-sm mb-3" role="alert" style={{ color: '#ef4444' }}>{error}</p>}
        {/* Styling rationale on .ofr-widget-panel in offers.css. */}
        <div className="ofr-widget-panel">
          <div ref={targetRef} style={{ minHeight: 320 }} />
        </div>
        <button type="button" onClick={() => setStep('form')} className="mt-4 w-full text-sm" style={{ color: '#8a8a8a' }}>
          ← Back
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit}>
      {notice && <p className="text-sm mb-3" role="status" style={{ color: '#d4d4d4' }}>{notice}</p>}
      {/* role="alert": a failed payment or a missing tick is announced, not
          only shown in red (OFFERSPOLISH.1). */}
      {error && <p id={ERROR_ID} className="text-sm mb-3" role="alert" style={{ color: '#ef4444' }}>{error}</p>}
      <div className="mt-2">
        <label className="ofr-label" htmlFor="ofr-name">Full name</label>
        <input id="ofr-name" name="name" className="ofr-input" required minLength={2} maxLength={120} autoComplete="name" enterKeyHint="next"
          value={fields.name} onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))} />
      </div>
      <div className="mt-5">
        <label className="ofr-label" htmlFor="ofr-email">Email</label>
        <input id="ofr-email" name="email" className="ofr-input" type="email" required maxLength={200} autoComplete="email" enterKeyHint="next"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          value={fields.email} onChange={(e) => setFields((f) => ({ ...f, email: e.target.value }))} />
      </div>
      <div className="mt-5">
        <label className="ofr-label" htmlFor="ofr-phone">Phone</label>
        <input id="ofr-phone" name="tel" className="ofr-input" type="tel" required minLength={6} maxLength={30} autoComplete="tel" enterKeyHint="go"
          value={fields.phone} onChange={(e) => setFields((f) => ({ ...f, phone: e.target.value }))} />
      </div>
      {activeTerms && <TermsTick terms={activeTerms} checked={termsAccepted} onChange={acceptTerms} invalid={termsInvalid} inputRef={termsRef} />}
      <button className="ofr-pay mt-8" type="submit" disabled={busy}>
        {busy ? 'One moment…' : `Pay ${priceLabel} — lock it in`}
      </button>
      <p className="text-center mt-4" style={{ color: '#777', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' }}>
        {isUn1t ? 'Secure checkout with un1t.online' : 'Secure checkout · Card · Apple Pay · Google Pay'}
      </p>
    </form>
  )
}

'use client'

// OfferCheckout — buyer form + embedded Revolut checkout for one sale offer
// (OFFERS.7). Clone of the ClassFunnelCheckout mount pattern, Revolut-only:
// POST /api/public/offers/[slug]/checkout creates the order server-side
// (price from sale_offers, never from here), then the SDK mounts against the
// returned token. A status poll on /api/public/offer-purchases/[id] is the
// paid fallback for redirect-style payment methods.
import { useEffect, useRef, useState } from 'react'
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'

export default function OfferCheckout({ slug, priceLabel, resumePurchaseId = null }) {
  // resumePurchaseId: set when Revolut redirected the buyer back after an
  // app-handoff payment (Revolut Pay on mobile) — start by confirming that
  // purchase instead of showing a fresh form.
  const [step, setStep] = useState(resumePurchaseId ? 'confirming' : 'form') // form | pay | confirming | paid
  const [fields, setFields] = useState({ name: '', email: '', phone: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [session, setSession] = useState(null) // { purchaseId, token }
  const targetRef = useRef(null)
  const instanceRef = useRef(null)
  const paidRef = useRef(false)

  const markPaid = () => { if (!paidRef.current) { paidRef.current = true; setStep('paid') } }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/public/offers/${slug}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 410) throw new Error('The sale has ended.')
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not start checkout. Please try again.')
      setSession({ purchaseId: j.data.purchaseId, token: j.data.checkout.token })
      setStep('pay')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
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
        {error && <p className="text-sm mb-3" style={{ color: '#ef4444' }}>{error}</p>}
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
      {error && <p className="text-sm mb-3" style={{ color: '#ef4444' }}>{error}</p>}
      <div className="mt-2">
        <label className="ofr-label" htmlFor="ofr-name">Full name</label>
        <input id="ofr-name" className="ofr-input" required minLength={2} maxLength={120} autoComplete="name"
          value={fields.name} onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))} />
      </div>
      <div className="mt-5">
        <label className="ofr-label" htmlFor="ofr-email">Email</label>
        <input id="ofr-email" className="ofr-input" type="email" required maxLength={200} autoComplete="email"
          value={fields.email} onChange={(e) => setFields((f) => ({ ...f, email: e.target.value }))} />
      </div>
      <div className="mt-5">
        <label className="ofr-label" htmlFor="ofr-phone">Phone</label>
        <input id="ofr-phone" className="ofr-input" type="tel" required minLength={6} maxLength={30} autoComplete="tel"
          value={fields.phone} onChange={(e) => setFields((f) => ({ ...f, phone: e.target.value }))} />
      </div>
      <button className="ofr-pay mt-8" type="submit" disabled={busy}>
        {busy ? 'One moment…' : `Pay ${priceLabel} — lock it in`}
      </button>
      <p className="text-center mt-4" style={{ color: '#777', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' }}>
        Secure checkout · Card · Apple Pay · Google Pay
      </p>
    </form>
  )
}

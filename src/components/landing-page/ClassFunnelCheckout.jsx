'use client'

// ClassFunnelCheckout — inline embedded Revolut checkout for a PAID class-funnel
// booking. The class_booking_requests row + Revolut order were created by
// /api/public/class-booking (Phase 1); this only mounts the SDK against the
// existing order token and watches for completion. Styled to sit inside the
// funnel's frosted card.
import { useEffect, useRef, useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'

const stripePromises = new Map()
function getStripe(pubKey, connectedAccountId) {
  const key = `${pubKey}::${connectedAccountId || ''}`
  if (!stripePromises.has(key)) {
    stripePromises.set(key, loadStripe(pubKey, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined))
  }
  return stripePromises.get(key)
}
const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''

export default function ClassFunnelCheckout({ paymentId, checkout, priceLabel, onPaid, onCancel }) {
  const targetRef = useRef(null)
  const instanceRef = useRef(null)
  const paidRef = useRef(false)
  const [error, setError] = useState(null)

  const markPaid = () => { if (!paidRef.current) { paidRef.current = true; onPaid?.() } }

  // Mount the Revolut embed once.
  useEffect(() => {
    if (!checkout?.token) { setError('Payment session is missing. Please refresh and try again.'); return }
    if (!targetRef.current || instanceRef.current) return
    let destroyed = false

    // ── Stripe Connect: mount Stripe Embedded Checkout inline ──
    if (checkout.provider === 'stripe_connect') {
      if (!STRIPE_PUBLISHABLE_KEY) { setError('Payment is not configured.'); return }
      getStripe(STRIPE_PUBLISHABLE_KEY, checkout.connectedAccountId)
        .then(async (stripe) => {
          if (destroyed) return
          if (!stripe) throw new Error('Could not load the payment widget.')
          const embedded = await stripe.createEmbeddedCheckoutPage({
            clientSecret: checkout.token,
            onComplete: () => { if (!destroyed) markPaid() },
          })
          if (destroyed) { try { embedded.destroy() } catch {} ; return }
          embedded.mount(targetRef.current)
          instanceRef.current = embedded
        })
        .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
      return () => { destroyed = true; try { instanceRef.current?.destroy?.() } catch {} ; instanceRef.current = null }
    }

    // ── Revolut: mount the Revolut embed ──
    if (checkout.provider !== 'revolut') { setError('This payment method is not available yet.'); return }
    if (!revolutPublicKey()) { setError('Payment is not configured.'); return }
    loadRevolutSdk(revolutMode())
      .then((RC) => {
        if (destroyed) return
        instanceRef.current = RC.embeddedCheckout({
          publicToken: revolutPublicKey(),
          mode: revolutMode(),
          locale: 'auto',
          target: targetRef.current,
          createOrder: async () => ({ publicId: checkout.token }),
          onSuccess: () => { if (!destroyed) markPaid() },
          onError: ({ error }) => { if (!destroyed) setError(error?.message || 'Payment failed. Please try again.') },
          onCancel: () => { if (!destroyed) onCancel?.() },
        })
      })
      .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
    return () => {
      destroyed = true
      try { instanceRef.current?.destroy?.() } catch {}
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout])

  // Poll the status route as a fallback (some methods don't fire onSuccess inline).
  useEffect(() => {
    if (!paymentId) return
    let stopped = false
    const tick = async () => {
      if (stopped || paidRef.current) return
      try {
        const r = await fetch(`/api/public/class-booking-payments/${paymentId}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!stopped && j?.data?.paid) { markPaid(); return }
      } catch { /* keep polling */ }
      if (!stopped) setTimeout(tick, 3000)
    }
    const t = setTimeout(tick, 3000)
    return () => { stopped = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId])

  return (
    <div>
      <div className="mb-4 text-center">
        <h1 className="font-display font-extrabold uppercase text-2xl mb-1">Secure checkout</h1>
        {priceLabel && <p className="text-white/60 text-sm">{priceLabel}</p>}
      </div>
      {error ? (
        <p className="text-sm text-red-300 text-center">{error}</p>
      ) : (
        /* WHITE panel behind the widget: it ships a light theme (dark labels)
           with no dark mode, so mounted bare on the dark funnel card its text
           was unreadable — same defect fixed on /offers in OFFERS.8d (#1293). */
        <div className="rounded-xl bg-white p-3">
          <div ref={targetRef} className="min-h-[320px]" />
        </div>
      )}
      {onCancel && !error && (
        <button type="button" onClick={onCancel} className="mt-4 w-full text-white/50 text-sm hover:text-white/80">← Back</button>
      )}
    </div>
  )
}

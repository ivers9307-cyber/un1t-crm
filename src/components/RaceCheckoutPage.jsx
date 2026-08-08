'use client'

// RaceCheckoutPage — embedded Revolut checkout for a race signup
// (mig 084). The race_payment row + Revolut order were created by
// /api/public/events/[slug]/register; this page only mounts the SDK
// against the existing order token.
//
// Flow:
//   1. Fetch /api/public/event-payments/[paymentId] — has the race
//      details + checkout token + status.
//   2. If status='completed' → redirect to /race/[slug]/confirmed
//      (handles the case where the buyer clicked back-then-forward
//      and the webhook landed in between).
//   3. Otherwise mount RC.embeddedCheckout against the token.
//   4. onSuccess → push to /race/[slug]/confirmed?registration=...

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { loadStripe } from '@stripe/stripe-js'
import { Loader2, AlertCircle, Lock } from 'lucide-react'
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'

const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ''

// loadStripe caches per (key, options) internally; we still guard so a
// re-render doesn't spin up a second loader for the same connected account.
const stripePromises = new Map()
function getStripe(pubKey, connectedAccountId) {
  const cacheKey = `${pubKey}::${connectedAccountId || ''}`
  if (!stripePromises.has(cacheKey)) {
    // Direct charge: init Stripe.js against the platform key WITH the host's
    // connected account, so the embedded widget renders on the host's account.
    stripePromises.set(cacheKey, loadStripe(pubKey, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined))
  }
  return stripePromises.get(cacheKey)
}

export default function RaceCheckoutPage({ paymentId }) {
  const router = useRouter()
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [phaseError, setPhaseError] = useState(null)
  // phase: loading | ready | paying | error. We track it for the
  // setters to drive UI internally even though the current render
  // doesn't read it explicitly — keeping the state machine intact
  // makes adding a dedicated "paying…" overlay trivial later.
  const [, setPhase] = useState('loading')

  const targetRef = useRef(null)
  const instanceRef = useRef(null)

  // Load payment + race info.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/event-payments/${paymentId}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (!j.success) {
          setLoadError(j.error || 'Payment not found')
          setPhase('error')
          return
        }
        setData(j.data)
        if (j.data?.status === 'completed') {
          // Already paid — webhook landed. Redirect to confirmation.
          const slug = j.data.race?.slug
          const regId = j.data.registration?.id
          if (slug) router.replace(`/event/${slug}/confirmed?registration=${regId || ''}`)
          return
        }
        // Both providers now render inline below: Revolut via its embed SDK,
        // Stripe Connect via Stripe Embedded Checkout — no off-site redirect.
      })
      .catch(e => {
        if (!cancelled) {
          setLoadError(e.message || 'Network error')
          setPhase('error')
        }
      })
    return () => { cancelled = true }
  }, [paymentId, router])

  // Mount the SDK once we have data + a target div.
  useEffect(() => {
    if (!data) return
    if (data.status !== 'pending') return
    if (!targetRef.current || instanceRef.current) return

    // ─── Stripe Connect: mount Stripe Embedded Checkout inline ───────
    if (data.provider === 'stripe_connect') {
      if (!STRIPE_PUBLISHABLE_KEY) {
        setPhase('error')
        setPhaseError('Payment is not configured (NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY missing).')
        return
      }
      const clientSecret = data.checkout?.token
      const connectedAccountId = data.checkout?.connected_account_id
      if (!clientSecret) {
        setPhase('error')
        setPhaseError('Payment session is missing. Please refresh.')
        return
      }

      let destroyed = false
      setPhase('paying')
      getStripe(STRIPE_PUBLISHABLE_KEY, connectedAccountId)
        .then(async (stripe) => {
          if (destroyed) return
          if (!stripe) throw new Error('Could not load payment widget')
          const checkout = await stripe.createEmbeddedCheckoutPage({
            clientSecret,
            onComplete: () => {
              if (destroyed) return
              const slug = data.race?.slug
              const regId = data.registration?.id
              router.push(`/event/${slug}/confirmed?registration=${regId || ''}`)
            },
          })
          if (destroyed) { try { checkout.destroy() } catch {} ; return }
          checkout.mount(targetRef.current)
          instanceRef.current = checkout
          setPhase('ready')
        })
        .catch((e) => {
          if (destroyed) return
          setPhase('error')
          setPhaseError(e.message || 'Could not load payment widget')
        })

      return () => {
        destroyed = true
        try { instanceRef.current?.destroy?.() } catch {}
        instanceRef.current = null
      }
    }

    // ─── Revolut: mount the Revolut embed SDK ────────────────────────
    if (!revolutPublicKey()) {
      setPhase('error')
      setPhaseError('Payment widget is not configured (NEXT_PUBLIC_REVOLUT_PUBLIC_KEY missing).')
      return
    }
    if (!data.checkout?.token) {
      setPhase('error')
      setPhaseError('Payment widget is missing a checkout token. Please refresh.')
      return
    }

    let destroyed = false
    setPhase('paying')

    loadRevolutSdk(revolutMode())
      .then((RC) => {
        if (destroyed) return
        const instance = RC.embeddedCheckout({
          publicToken: revolutPublicKey(),
          mode: revolutMode(),
          locale: 'auto',
          target: targetRef.current,
          // Order already exists — just hand back its token.
          createOrder: async () => ({ publicId: data.checkout.token }),
          onSuccess: () => {
            if (destroyed) return
            const slug = data.race?.slug
            const regId = data.registration?.id
            router.push(`/event/${slug}/confirmed?registration=${regId || ''}`)
          },
          onError: ({ error }) => {
            if (destroyed) return
            setPhase('error')
            setPhaseError(error?.message || 'Payment failed. Please try again.')
          },
          onCancel: () => {
            if (destroyed) return
            setPhase('ready')
            setPhaseError(null)
          },
        })
        instanceRef.current = instance
        setPhase('ready')
      })
      .catch((e) => {
        if (destroyed) return
        setPhase('error')
        setPhaseError(e.message || 'Could not load payment widget')
      })

    return () => {
      destroyed = true
      try { instanceRef.current?.destroy?.() } catch {}
      instanceRef.current = null
    }
  }, [data, router])

  if (loadError) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="lp-card-glow rounded-2xl p-8 max-w-sm text-center">
          <AlertCircle size={32} className="mx-auto text-red-300 mb-3" />
          <p className="text-white/70">{loadError}</p>
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <Loader2 size={28} className="animate-spin text-white/40" />
      </div>
    )
  }

  const fmt = (cents, currency) => {
    const major = (cents / 100).toFixed(2)
    if (currency === 'EUR') return `€${major}`
    if (currency === 'GBP') return `£${major}`
    return `${major} ${currency}`
  }

  return (
    <div className="min-h-screen bg-black text-white py-14 px-4">
      {/* Narrow single column on mobile; roomier two-column on desktop so
          the booking summary sits alongside the payment widget (which the
          provider SDK sizes to fill its container) instead of above it. */}
      <div className="max-w-md lg:max-w-4xl mx-auto">
        <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold mb-4">
          Checkout
        </p>

        <div className="lg:grid lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-6 lg:items-start">
          {/* Booking summary — ticket stub. Sticky on desktop so it stays
              in view while a tall payment form scrolls. */}
          <div className="lp-card-glow rounded-2xl overflow-hidden lg:sticky lg:top-14">
            {/* top: event + team */}
            <div className="px-6 pt-6 pb-5">
              <h1 className="font-bold text-lg leading-snug">{data.race?.name || 'Your race'}</h1>
              {data.registration?.team_name && (
                <p className="text-sm text-white/60 mt-1">
                  Team <strong className="text-white font-semibold">{data.registration.team_name}</strong>
                </p>
              )}
              {data.registration?.team_size > 1 && (
                <p className="text-xs text-white/45 mt-1 tabular-nums">{data.registration.team_size} people</p>
              )}
            </div>

            {/* Perforated divider with punched notches */}
            <div className="relative h-0 border-t border-dashed border-white/15">
              <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
              <span className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
            </div>

            {/* bottom: itemised breakdown + total. When there's a booking
                fee we spell out entry + fee so the buyer sees what they're
                paying for here, rather than under Stripe's collapsed
                "View details". No fee (Revolut/internal) → just the total. */}
            <div className="px-6 pt-5 pb-6">
              {data.booking_fee_cents > 0 && (
                <div className="space-y-2 text-sm mb-4">
                  <div className="flex items-baseline justify-between text-white/70">
                    <span>Entry</span>
                    <span className="tabular-nums text-white/90">
                      {fmt(data.amount_cents - data.booking_fee_cents, data.currency)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between text-white/70">
                    <span>Booking fee</span>
                    <span className="tabular-nums text-white/90">
                      {fmt(data.booking_fee_cents, data.currency)}
                    </span>
                  </div>
                  <div className="border-t border-dashed border-white/15 pt-3" />
                </div>
              )}
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] uppercase tracking-[0.16em] text-white/55 font-semibold">
                  Total
                </span>
                <span className="text-3xl font-bold tabular-nums">
                  {fmt(data.amount_cents, data.currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Payment widget */}
          <div className="lp-card-glow rounded-2xl p-4 sm:p-5 mt-4 lg:mt-0">
            {phaseError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> {phaseError}
              </div>
            )}

            {/* Embedded Checkout (Revolut or Stripe) mounts here — ref + min-height must remain.
                WHITE panel: the Revolut widget ships a light theme (dark labels/inputs) with no
                dark mode, so on the old bg-white/[0.03] its text was unreadable — the same defect
                fixed on /offers in OFFERS.8d (PR #1293). */}
            <div className="rounded-xl bg-white p-3">
              <div ref={targetRef} className="min-h-[280px]" />
            </div>

            <div className="text-white/45 text-[11px] mt-4 flex items-center justify-center gap-1.5 w-full">
              <Lock size={11} /> Secure payment by {data.provider === 'stripe_connect' ? 'Stripe' : 'Revolut'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

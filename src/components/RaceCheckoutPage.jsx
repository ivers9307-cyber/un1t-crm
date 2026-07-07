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
import { Loader2, AlertCircle, Lock } from 'lucide-react'

const SDK_URLS = {
  sandbox: 'https://sandbox-merchant.revolut.com/embed.js',
  prod: 'https://merchant.revolut.com/embed.js',
}

let sdkPromise = null
function loadRevolutSdk(mode) {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'))
  if (window.RevolutCheckout) return Promise.resolve(window.RevolutCheckout)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    const url = SDK_URLS[mode] || SDK_URLS.sandbox
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => resolve(window.RevolutCheckout)
    script.onerror = () => reject(new Error('Failed to load Revolut SDK'))
    document.head.appendChild(script)
  })
  return sdkPromise
}

const REVOLUT_MODE = process.env.NEXT_PUBLIC_REVOLUT_MODE === 'prod' ? 'prod' : 'sandbox'
const REVOLUT_PUBLIC_KEY = process.env.NEXT_PUBLIC_REVOLUT_PUBLIC_KEY || ''

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
        }
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
    if (!REVOLUT_PUBLIC_KEY) {
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

    loadRevolutSdk(REVOLUT_MODE)
      .then((RC) => {
        if (destroyed) return
        const instance = RC.embeddedCheckout({
          publicToken: REVOLUT_PUBLIC_KEY,
          mode: REVOLUT_MODE,
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
      <div className="max-w-md mx-auto">
        <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold mb-4">
          Checkout
        </p>

        <div className="lp-card-glow rounded-2xl overflow-hidden">
          {/* Ticket stub — top: event + team */}
          <div className="px-6 pt-6 pb-5">
            <h1 className="font-bold text-lg leading-snug">{data.race?.name || 'Your race'}</h1>
            {data.registration?.team_name && (
              <p className="text-sm text-white/60 mt-1">
                Team <strong className="text-white font-semibold">{data.registration.team_name}</strong>
              </p>
            )}
          </div>

          {/* Perforated divider with punched notches */}
          <div className="relative h-0 border-t border-dashed border-white/15">
            <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
            <span className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
          </div>

          {/* Ticket stub — bottom: total + payment */}
          <div className="px-6 pt-5 pb-6">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] uppercase tracking-[0.16em] text-white/55 font-semibold">
                Total
              </span>
              <span className="text-3xl font-bold tabular-nums">
                {fmt(data.amount_cents, data.currency)}
              </span>
            </div>

            {phaseError && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> {phaseError}
              </div>
            )}

            {/* Revolut Embedded Checkout mounts here — ref + min-height must remain */}
            <div className="mt-5 rounded-xl bg-white/[0.03] border border-white/10 p-3">
              <div ref={targetRef} className="min-h-[280px]" />
            </div>

            <div className="text-white/45 text-[11px] mt-4 flex items-center justify-center gap-1.5 w-full">
              <Lock size={11} /> Secure payment by Revolut
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'

// Public-facing deposit page using Revolut's Embedded Checkout
// widget. Buyer never leaves our domain. The widget handles cards +
// Apple Pay + Google Pay + Revolut Pay automatically, plus 3DS / SCA
// transparently. Card details enter Revolut-controlled iframes so
// PCI scope stays minimal.
//
// Flow (verified against merchant-2026-03-12.yaml + @revolut/checkout
// SDK source):
//   1. Page loads → fetch deposit data → render T&Cs + checkbox
//   2. Buyer ticks accept → widget mounts in the payment area below
//   3. Buyer picks a payment method, enters details, clicks the
//      widget's own pay button
//   4. Widget calls our `createOrder` callback → we POST to
//      accept-and-pay (records consent + creates Revolut order on the
//      server) → return { publicId: orderToken } to the widget
//   5. Widget processes the payment (handling 3DS as needed) →
//      onSuccess callback fires → we refetch deposit data → show
//      receipt inline. The webhook is still authoritative for the
//      database flip.

import { useEffect, useRef, useState } from 'react'
import { Lock, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'

const SDK_URLS = {
  sandbox: 'https://sandbox-merchant.revolut.com/embed.js',
  prod: 'https://merchant.revolut.com/embed.js',
}

// Cache the loader promise so React StrictMode (or remounts) share a
// single script tag.
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

export default function CarDepositPage({ token }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loadErrorCode, setLoadErrorCode] = useState(null)
  const [accepted, setAccepted] = useState(false)

  // 'idle' | 'mounting' | 'ready' | 'paying' | 'paid' | 'error'
  const [phase, setPhase] = useState('idle')
  const [phaseError, setPhaseError] = useState(null)
  // Hosted-page fallback URL — populated after the first createOrder
  // call so we have something to give the buyer if the widget glitches.
  const [hostedFallbackUrl, setHostedFallbackUrl] = useState(null)

  const widgetTargetRef = useRef(null)
  const widgetInstanceRef = useRef(null)

  // ── Initial deposit-data fetch ─────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/deposit/${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (!j.success) {
          setLoadError(j.error || 'Could not load deposit page')
          setLoadErrorCode(j.code || null)
        } else {
          setData(j)
        }
      })
      .catch(e => !cancelled && setLoadError(e.message || 'Network error'))
    return () => { cancelled = true }
  }, [token])

  // ── Mount the embedded checkout widget once terms are accepted ──
  useEffect(() => {
    if (!accepted || !data || !widgetTargetRef.current || widgetInstanceRef.current) return
    if (data.status === 'paid') return
    let destroyed = false

    if (!REVOLUT_PUBLIC_KEY) {
      setPhase('error')
      setPhaseError('Payment widget is not configured (NEXT_PUBLIC_REVOLUT_PUBLIC_KEY missing).')
      return
    }

    setPhase('mounting')
    setPhaseError(null)

    loadRevolutSdk(REVOLUT_MODE)
      .then((RC) => {
        if (destroyed) return
        // SDK source (embeddedCheckoutLoader.js) shows embeddedCheckout
        // is exposed as a static method on the loaded RevolutCheckout
        // function. Returns an instance with .destroy().
        const instance = RC.embeddedCheckout({
          publicToken: REVOLUT_PUBLIC_KEY,
          mode: REVOLUT_MODE,
          locale: 'auto',
          target: widgetTargetRef.current,
          // SDK calls this when the buyer submits payment in the widget.
          // We POST to our backend, which records the T&C acceptance
          // (terms_version + IP + timestamp) and creates the Revolut
          // order. The SDK expects { publicId: <order-token> }.
          createOrder: async () => {
            const res = await fetch(
              `/api/public/deposit/${encodeURIComponent(token)}/accept-and-pay`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ terms_version: data.terms.version }),
              }
            )
            const j = await res.json()
            if (!j.success) {
              if (j.code === 'TERMS_VERSION_MISMATCH' || j.code === 'TOKEN_EXPIRED') {
                window.location.reload()
              }
              throw new Error(j.error || 'Could not create order')
            }
            // Save the hosted URL so the small fallback link shows
            // up after the first attempted submit.
            if (j.checkout_url) setHostedFallbackUrl(j.checkout_url)
            // The SDK keeps using `publicId` as the field name even
            // though the API renamed the underlying value to `token`.
            return { publicId: j.public_id }
          },
          onSuccess: ({ orderId: _orderId }) => {
            if (destroyed) return
            setPhase('paid')
            // Refetch to render the receipt — webhook usually has
            // landed by now and reflects 'paid' status.
            fetch(`/api/public/deposit/${encodeURIComponent(token)}`)
              .then(r => r.json())
              .then(j => { if (!destroyed && j.success) setData(j) })
              .catch(() => {})
          },
          onError: ({ error, orderId: _orderId }) => {
            if (destroyed) return
            setPhase('error')
            setPhaseError(error?.message || 'Payment failed. Please try again.')
          },
          onCancel: ({ orderId: _orderId }) => {
            if (destroyed) return
            // Buyer dismissed without paying — back to ready state.
            setPhase('ready')
            setPhaseError(null)
          },
        })
        widgetInstanceRef.current = instance
        setPhase('ready')
      })
      .catch((err) => {
        if (destroyed) return
        setPhase('error')
        setPhaseError(err.message || 'Could not load payment widget')
      })

    return () => {
      destroyed = true
      try { widgetInstanceRef.current?.destroy?.() } catch {}
      widgetInstanceRef.current = null
    }
  }, [accepted, data, token])

  // ── Render ─────────────────────────────────────────────────────
  if (loadError) {
    const isExpired = loadErrorCode === 'TOKEN_EXPIRED'
    const cls = isExpired
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-red-50 border-red-200 text-red-700'
    return (
      <Centered>
        <div className={`border rounded-xl p-6 text-center ${cls}`}>
          <AlertCircle className="mx-auto mb-2" size={28} />
          <p className="font-semibold">
            {isExpired ? 'This payment link has expired' : loadError}
          </p>
          {isExpired && (
            <p className="text-sm mt-1">
              Please contact the dealer to reissue a new link.
            </p>
          )}
        </div>
      </Centered>
    )
  }
  if (!data) return <Centered><p className="text-gray-500">Loading…</p></Centered>

  // Already paid (DB-confirmed via webhook OR SDK onSuccess just fired).
  if (data.status === 'paid' || phase === 'paid') {
    const amount = data.paid_amount ?? data.amount
    const paidBrandLogo = data.branding?.logo_url || null
    const paidBrandName = data.branding?.company_name || ''
    return (
      <Centered>
        <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center">
          {paidBrandLogo && (
            <div className="flex justify-center mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={paidBrandLogo} alt={paidBrandName || 'Dealer'} className="max-h-12 w-auto object-contain" />
            </div>
          )}
          <CheckCircle2 className="mx-auto mb-3 text-green-600" size={40} />
          <h1 className="text-xl font-bold text-gray-900 mb-1">Deposit received</h1>
          <p className="text-sm text-gray-700 mb-2">
            Thank you. Your deposit of €{Number(amount).toFixed(2)} has been received and the
            <strong> {data.car.label}{data.car.reg ? ` (${data.car.reg})` : ''}</strong> is now reserved for you.
          </p>
          {data.paid_at && (
            <p className="text-xs text-gray-500">
              Paid on {new Date(data.paid_at).toLocaleString('en-IE')}
            </p>
          )}
          {!data.paid_at && phase === 'paid' && (
            <p className="text-xs text-gray-500">
              Confirmation will arrive by email shortly.
            </p>
          )}
        </div>
      </Centered>
    )
  }

  // Per-location buyer-facing branding. CCF Autos cars surface CCF
  // Autos's logo + company name; UN1T cars surface UN1T's. data.branding
  // is { logo_url, company_name } populated by /api/public/deposit/[token].
  const brandLogo = data.branding?.logo_url || null
  const brandName = data.branding?.company_name || ''
  const headingPrefix = brandName ? `${brandName} — ` : ''

  return (
    <Centered>
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 sm:p-8">
        {brandLogo && (
          <div className="flex justify-center mb-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brandLogo}
              alt={brandName || 'Dealer'}
              className="max-h-14 sm:max-h-16 w-auto object-contain"
            />
          </div>
        )}
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">{headingPrefix}Car Deposit</h1>
        <p className="text-sm text-gray-600 mb-6">
          Secure the <strong>{data.car.label}{data.car.reg ? ` (${data.car.reg})` : ''}</strong> with a
          €{data.amount.toFixed(2)} deposit.
        </p>

        {/* Terms */}
        <section className="mb-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Terms &amp; conditions</h2>
          {data.terms.text ? (
            <div className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-4 max-h-72 overflow-auto">
              {data.terms.text}
            </div>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              The dealer hasn't published terms for this deposit yet. Please contact them before paying.
            </div>
          )}
          <label className="flex items-start gap-2 mt-3 cursor-pointer">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={phase === 'mounting' || phase === 'paying'}
              className="mt-1 cursor-pointer"
            />
            <span className="text-sm text-gray-800">
              I have read and accept the terms above. I understand that the deposit is
              <strong> non-refundable</strong> and secures the car for me.
            </span>
          </label>
        </section>

        {/* Payment widget */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Payment</h2>
          <p className="text-xs text-gray-500 mb-3 inline-flex items-center gap-1">
            <Lock size={11} /> Secure payment via Revolut. Card details go directly to Revolut — they never touch our servers.
          </p>

          {!accepted && (
            <div className="text-xs text-gray-500 italic">
              Accept the terms above to load the payment options.
            </div>
          )}

          {accepted && phase === 'mounting' && (
            <div className="text-xs text-gray-500">Loading payment options…</div>
          )}

          {/* The widget's mount point. Always rendered after acceptance
              so the ref is stable for the SDK; min-height prevents
              layout jank while the iframe negotiates its size. */}
          <div
            ref={widgetTargetRef}
            className="mt-2"
            style={{ minHeight: accepted ? 320 : 0, display: accepted ? 'block' : 'none' }}
          />

          {phaseError && (
            <p className="text-xs text-red-600 mt-3 inline-flex items-start gap-1">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {phaseError}
            </p>
          )}

          {/* Hosted-page fallback link — only appears after we've
              attempted to create an order at least once (so we have
              the URL). Useful escape hatch if the embedded widget
              misbehaves on a particular buyer's network. */}
          {hostedFallbackUrl && phase !== 'paid' && (
            <p className="mt-4 text-center">
              <a
                href={hostedFallbackUrl}
                className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
              >
                <ExternalLink size={11} /> Pay on Revolut's site instead
              </a>
            </p>
          )}
        </section>
      </div>
    </Centered>
  )
}

function Centered({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10 sm:py-16">
      <div className="max-w-xl mx-auto">{children}</div>
    </div>
  )
}

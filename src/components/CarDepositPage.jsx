'use client'

// Public-facing deposit page. Inline payment via Revolut's
// `createCardField` SDK — buyer never leaves our domain. The card
// details render in a Revolut-controlled iframe so PCI scope stays
// minimal; the SDK handles 3DS / SCA in a popup transparently.
//
// Flow:
//   1. Page loads → fetch deposit data → render T&Cs + accept checkbox
//   2. Buyer ticks accept → 'Continue to payment' button enables
//   3. Click → POST /accept-and-pay → backend records consent +
//      creates a Revolut order, returns public_id
//   4. embed.js dynamically injected (NEXT_PUBLIC_REVOLUT_MODE picks
//      sandbox vs prod). RevolutCheckout(public_id, mode).createCardField()
//      mounts the card iframe in our target div.
//   5. Buyer enters card details → clicks 'Pay €X' → cardField.submit()
//   6. SDK runs the auth flow (3DS popup if required) → onSuccess /
//      onError / onCancel callback. We refetch the deposit data on
//      success — the webhook is the authoritative state source but
//      typically lands within seconds.

import { useEffect, useRef, useState } from 'react'
import { Lock, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'

const SDK_URLS = {
  sandbox: 'https://sandbox-merchant.revolut.com/embed.js',
  prod: 'https://merchant.revolut.com/embed.js',
}

// Cache the loaded SDK promise so multiple mounts (or remounts via
// React StrictMode in dev) share one script tag.
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

export default function CarDepositPage({ token }) {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [accepted, setAccepted] = useState(false)

  // 'idle' → 'creating' (POST in flight) → 'card' (field mounted) →
  // 'paying' (cardField.submit() in flight) → 'paid' (success) | 'error'
  const [phase, setPhase] = useState('idle')
  const [phaseError, setPhaseError] = useState(null)
  const [order, setOrder] = useState(null)        // { public_id, checkout_url, order_id }
  const [cardField, setCardField] = useState(null)
  const [cardComplete, setCardComplete] = useState(false)

  const cardFieldRef = useRef(null)

  // ── Initial deposit-data fetch ─────────────────────────────────
  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/deposit/${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (!j.success) setLoadError(j.error || 'Could not load deposit page')
        else setData(j)
      })
      .catch(e => !cancelled && setLoadError(e.message || 'Network error'))
    return () => { cancelled = true }
  }, [token])

  // ── Mount the card field once we have a public_id ──────────────
  useEffect(() => {
    if (!order?.public_id || cardField || !cardFieldRef.current) return
    let destroyed = false
    let instance = null
    let field = null

    loadRevolutSdk(REVOLUT_MODE)
      .then((RC) => RC(order.public_id, REVOLUT_MODE))
      .then((rc) => {
        if (destroyed) return
        instance = rc
        field = rc.createCardField({
          target: cardFieldRef.current,
          theme: 'light',
          hidePostcodeField: false,
          // Status callback drives the 'Pay' button enable state.
          onStatusChange: (status) => {
            if (destroyed) return
            setCardComplete(!!status.completed && !status.invalid)
          },
          onSuccess: () => {
            if (destroyed) return
            setPhase('paid')
            // Refetch the deposit data — the webhook usually has
            // landed by now and reflects 'paid' status. If not, the
            // success view falls back to the SDK callback signal.
            fetch(`/api/public/deposit/${encodeURIComponent(token)}`)
              .then(r => r.json())
              .then(j => { if (!destroyed && j.success) setData(j) })
              .catch(() => {})
          },
          onError: (err) => {
            if (destroyed) return
            setPhase('error')
            setPhaseError(err?.message || 'Payment failed. Please try again.')
          },
          onCancel: () => {
            if (destroyed) return
            setPhase('card')   // back to the card field, ready to retry
            setPhaseError(null)
          },
        })
        setCardField(field)
        setPhase('card')
      })
      .catch((err) => {
        if (destroyed) return
        setPhase('error')
        setPhaseError(err.message || 'Could not load payment widget')
      })

    return () => {
      destroyed = true
      try { field?.destroy?.() } catch {}
      try { instance?.destroy?.() } catch {}
    }
  }, [order?.public_id, cardField, token])

  // ── Actions ────────────────────────────────────────────────────
  async function continueToPayment() {
    setPhase('creating')
    setPhaseError(null)
    try {
      const res = await fetch(`/api/public/deposit/${encodeURIComponent(token)}/accept-and-pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms_version: data.terms.version }),
      })
      const j = await res.json()
      if (!j.success) {
        setPhase('idle')
        setPhaseError(j.error || 'Could not start payment')
        if (j.code === 'TERMS_VERSION_MISMATCH') window.location.reload()
        return
      }
      if (!j.public_id) {
        // Backend talked to Revolut but got no token — fall back to
        // the hosted page so the buyer isn't stuck.
        if (j.checkout_url) {
          window.location.href = j.checkout_url
          return
        }
        setPhase('idle')
        setPhaseError('Payment provider returned no token')
        return
      }
      setOrder(j)   // triggers the mount effect above
    } catch (e) {
      setPhase('idle')
      setPhaseError(e.message || 'Network error')
    }
  }

  function pay() {
    if (!cardField) return
    setPhase('paying')
    setPhaseError(null)
    cardField.submit({
      // Pre-fill the cardholder name where we know it. Phone/email
      // are optional and we don't always have them on the buyer side.
      name: data?.car?.buyer_name || undefined,
    })
  }

  // ── Render ─────────────────────────────────────────────────────
  if (loadError) {
    return (
      <Centered>
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700 text-center">
          <AlertCircle className="mx-auto mb-2" size={28} />
          <p className="font-semibold">{loadError}</p>
        </div>
      </Centered>
    )
  }
  if (!data) return <Centered><p className="text-gray-500">Loading…</p></Centered>

  // Already paid (DB-confirmed via webhook, OR SDK onSuccess just fired).
  if (data.status === 'paid' || phase === 'paid') {
    const amount = data.paid_amount ?? data.amount
    return (
      <Centered>
        <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center">
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

  return (
    <Centered>
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 sm:p-8">
        {/* Title */}
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1">Tesla Car Deposit</h1>
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
              disabled={phase !== 'idle'}
              className="mt-1 cursor-pointer"
            />
            <span className="text-sm text-gray-800">
              I have read and accept the terms above. I understand that the deposit is
              <strong> non-refundable</strong> and secures the car for me.
            </span>
          </label>
        </section>

        {/* Payment */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Payment</h2>
          <p className="text-xs text-gray-500 mb-3 inline-flex items-center gap-1">
            <Lock size={11} /> Secure payment via Revolut. Card details go directly to Revolut — they never touch our servers.
          </p>

          {phase === 'idle' && (
            <button
              onClick={continueToPayment}
              disabled={!accepted || !data.terms.text}
              className="w-full bg-black text-white font-semibold py-3 px-5 rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Continue to payment
            </button>
          )}

          {phase === 'creating' && (
            <button disabled className="w-full bg-black text-white font-semibold py-3 px-5 rounded-lg opacity-60">
              Preparing secure payment…
            </button>
          )}

          {/* Card field is mounted here once we have a public_id.
              Always rendered (display:none when not on the card phase)
              so the ref is stable for the SDK. */}
          <div
            ref={cardFieldRef}
            className="mt-2 mb-3 min-h-[120px]"
            style={{ display: phase === 'card' || phase === 'paying' || phase === 'error' ? 'block' : 'none' }}
          />

          {(phase === 'card' || phase === 'paying' || phase === 'error') && (
            <button
              onClick={pay}
              disabled={phase === 'paying' || !cardComplete}
              className="w-full bg-black text-white font-semibold py-3 px-5 rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {phase === 'paying' ? 'Processing payment…' : `Pay €${data.amount.toFixed(2)} deposit`}
            </button>
          )}

          {phaseError && (
            <p className="text-xs text-red-600 mt-3 inline-flex items-start gap-1">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {phaseError}
            </p>
          )}

          {/* Hosted-page fallback link. Always available once we have
              an order created — useful if the SDK iframe glitches on
              the buyer's network or device. */}
          {order?.checkout_url && phase !== 'paid' && (
            <p className="mt-4 text-center">
              <a
                href={order.checkout_url}
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

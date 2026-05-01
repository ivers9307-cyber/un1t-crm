'use client'

// Public-facing deposit page. Loads its data from the public GET
// endpoint then renders:
//   1. Title 'Tesla Car Deposit'
//   2. Car summary (make/model + reg)
//   3. T&Cs body (operator-editable per location, mig 046)
//   4. Accept checkbox + 'Pay €X deposit' button
// On click, POSTs to /api/public/deposit/<token>/accept-and-pay
// which records the acceptance + creates a Revolut order, then
// redirects the browser to Revolut's hosted checkout URL.

import { useEffect, useState } from 'react'
import { Lock, CheckCircle2, AlertCircle } from 'lucide-react'

export default function CarDepositPage({ token }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [accepted, setAccepted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState(null)

  useEffect(() => {
    fetch(`/api/public/deposit/${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) setError(j.error || 'Could not load deposit page')
        else setData(j)
      })
      .catch(e => setError(e.message || 'Network error'))
  }, [token])

  async function handlePay() {
    setSubmitting(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/public/deposit/${encodeURIComponent(token)}/accept-and-pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms_version: data.terms.version }),
      })
      const j = await res.json()
      if (!j.success) {
        setActionError(j.error || 'Could not start payment')
        // Stale terms — refresh so the buyer reads the new copy
        // before retrying. They keep their accept-checkbox state
        // unchecked because the new version hasn't been agreed yet.
        if (j.code === 'TERMS_VERSION_MISMATCH') window.location.reload()
        return
      }
      // Hand off to Revolut's hosted checkout.
      window.location.href = j.checkout_url
    } catch (e) {
      setActionError(e.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  if (error) {
    return (
      <Centered>
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700 text-center">
          <AlertCircle className="mx-auto mb-2" size={28} />
          <p className="font-semibold">{error}</p>
        </div>
      </Centered>
    )
  }
  if (!data) return <Centered><p className="text-gray-500">Loading…</p></Centered>

  // Already paid — short-circuit to a confirmation view.
  if (data.status === 'paid') {
    return (
      <Centered>
        <div className="bg-green-50 border border-green-200 rounded-xl p-8 text-center">
          <CheckCircle2 className="mx-auto mb-3 text-green-600" size={40} />
          <h1 className="text-xl font-bold text-gray-900 mb-1">Deposit received</h1>
          <p className="text-sm text-gray-700 mb-2">
            Thank you. Your deposit of €{(data.paid_amount ?? data.amount).toFixed(2)} has been received and the
            <strong> {data.car.label}{data.car.reg ? ` (${data.car.reg})` : ''}</strong> is now reserved for you.
          </p>
          {data.paid_at && (
            <p className="text-xs text-gray-500">Paid on {new Date(data.paid_at).toLocaleString('en-IE')}</p>
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
              className="mt-1 cursor-pointer"
            />
            <span className="text-sm text-gray-800">
              I have read and accept the terms above. I understand that the deposit is
              <strong> non-refundable</strong> and secures the car for me.
            </span>
          </label>
        </section>

        {/* Pay */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">Payment</h2>
          <p className="text-xs text-gray-500 mb-3 inline-flex items-center gap-1">
            <Lock size={11} /> Secure payment via Revolut. Your card details never touch our servers.
          </p>
          <button
            onClick={handlePay}
            disabled={!accepted || submitting || !data.terms.text}
            className="w-full bg-black text-white font-semibold py-3 px-5 rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Redirecting to Revolut…' : `Pay €${data.amount.toFixed(2)} deposit`}
          </button>
          {actionError && (
            <p className="text-xs text-red-600 mt-3 inline-flex items-start gap-1">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {actionError}
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

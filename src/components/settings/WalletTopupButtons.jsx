'use client'

// INTEG-C2b — fixed-denomination wallet top-up buttons on
// /settings/billing (one row per pinned location's wallet block).
// POST /api/settings/billing/topup mints a pending TU invoice and a
// Stripe Checkout Session (plain platform charge), then we send the
// browser to the hosted checkout URL. Denominations are the server's
// whitelist (imported constant — no free-form amounts); VAT (23%) is
// charged on top of the credited amount, and the buttons say so.

import { useState } from 'react'

// Mirror of the server's whitelist (src/lib/wallet-topup.js
// TOPUP_DENOMINATIONS_CENTS / TOPUP_VAT_RATE_PERCENT) — NOT imported:
// that module pulls the Stripe/Postmark server SDKs into the client
// bundle. Same convention as AutoTopupForm's mirrored Zod bounds; the
// server whitelist is authoritative either way.
const TOPUP_DENOMINATIONS_CENTS = [2500, 5000, 10000, 25000]
const TOPUP_VAT_RATE_PERCENT = 23

function euros(cents) {
  const n = Number(cents) / 100
  return Number.isInteger(n) ? `€${n}` : `€${n.toFixed(2)}`
}

export default function WalletTopupButtons({ locationId }) {
  const [startingCents, setStartingCents] = useState(null)
  const [error, setError] = useState(null)

  async function startTopup(amountCents) {
    setStartingCents(amountCents)
    setError(null)
    let json
    try {
      const res = await fetch('/api/settings/billing/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, amount_cents: amountCents }),
      })
      json = await res.json()
    } catch {
      json = { success: false, error: 'Network error starting the top-up. Try again.' }
    }
    if (!json.success || !json.data?.checkout_url) {
      setError(json.error || 'Could not start the top-up checkout. Try again.')
      setStartingCents(null)
      return
    }
    // Off to Stripe's hosted checkout; success/cancel land back on
    // /settings/billing?topup=… (no state to keep here).
    window.location.assign(json.data.checkout_url)
  }

  return (
    <div className="border-t border-un1t-border pt-4 mt-4">
      <div className="text-sm font-medium mb-1">Top up</div>
      <p className="text-xs text-un1t-subtle mb-3 max-w-xl">
        Add credit with a one-off card payment. VAT ({TOPUP_VAT_RATE_PERCENT}%) is added at
        checkout and a VAT invoice is emailed to you once the payment lands.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 mb-3">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TOPUP_DENOMINATIONS_CENTS.map((cents) => (
          <button
            key={cents}
            type="button"
            disabled={startingCents !== null}
            onClick={() => startTopup(cents)}
            className="text-sm bg-un1t-text text-un1t-bg px-4 py-2 rounded-md hover:bg-un1t-accent transition-colors font-medium disabled:opacity-50"
          >
            {startingCents === cents ? 'Opening checkout…' : `+${euros(cents)}`}
          </button>
        ))}
      </div>
    </div>
  )
}

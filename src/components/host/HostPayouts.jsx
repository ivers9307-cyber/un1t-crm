'use client'

// HOST-PORTAL.12 — host payout/balance visibility. Self-fetching section for
// the host dashboard: Stripe balance (Available / On the way) + the last few
// payouts, read from /api/host/stripe/payouts. Graceful-degrade contract: the
// route returns data:null for non-Stripe hosts or ANY Stripe failure, and this
// component renders NOTHING in that case (or on fetch error) — the dashboard
// must never gain a broken section because Stripe is unreachable.
//
// Themed with the host class kit (host-ui.js): chips and surfaces use the
// `host-*` tokens, so they are right in light and dark.

import { createContext, useContext, useEffect, useState } from 'react'
import { HOST_CHIP, HOST_CHIP_TONE, HOST_EYEBROW, HOST_LIST, HOST_META, HOST_HINT } from './host-ui'

// Kept private: src/lib/host-portal.js imports server-only code (location-time),
// which must not enter this client bundle.
function formatMoney(cents, currency) {
  const n = (Number(cents) || 0) / 100
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: (currency || 'EUR').toUpperCase(),
    }).format(n)
  } catch {
    return `€${n.toFixed(2)}`
  }
}

function formatUnixDate(seconds) {
  const d = new Date((Number(seconds) || 0) * 1000)
  if (!seconds || Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Payout status chips (paid = money landed; pending/in_transit =
// on the way; failed/canceled = needs the host's attention in Stripe).
const PAYOUT_STATUS_CHIP = {
  paid: `${HOST_CHIP} ${HOST_CHIP_TONE.ok}`,
  pending: `${HOST_CHIP} ${HOST_CHIP_TONE.warn}`,
  in_transit: `${HOST_CHIP} ${HOST_CHIP_TONE.warn}`,
  failed: `${HOST_CHIP} ${HOST_CHIP_TONE.bad}`,
  canceled: `${HOST_CHIP} ${HOST_CHIP_TONE.bad}`,
}

const PAYOUT_STATUS_LABEL = {
  paid: 'Paid',
  pending: 'Pending',
  in_transit: 'In transit',
  failed: 'Failed',
  canceled: 'Canceled',
}

const PayoutsContext = createContext(null)

// Fetches /api/host/stripe/payouts once and shares the result (data|null) with
// HostBalance and HostPayoutList, so the Earnings page needs a single request.
export function HostPayoutsProvider({ children }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/host/stripe/payouts', { cache: 'no-store' })
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok && json.success && json.data) setData(json.data)
      } catch {
        // Render nothing on network failure — same posture as data:null.
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return <PayoutsContext.Provider value={data}>{children}</PayoutsContext.Provider>
}

// No data (non-Stripe host, Stripe error, fetch failed, still loading) →
// each block renders nothing at all, heading included.
export function HostBalance() {
  const data = useContext(PayoutsContext)
  if (!data) return null
  const cur = data.balance?.currency || 'EUR'
  return (
    <section className="mt-8">
      <h2 className={`${HOST_EYEBROW} mb-3`}>Balance</h2>
      <div className="grid grid-cols-2 gap-3 max-w-md">
        <div className="rounded-xl border border-host-border bg-host-panel px-4 py-3">
          <p className={HOST_META}>Available</p>
          <p className="text-lg font-semibold mt-1 tabular-nums">
            {formatMoney(data.balance?.available_cents, cur)}
          </p>
        </div>
        <div className="rounded-xl border border-host-border bg-host-panel px-4 py-3">
          <p className={HOST_META}>On the way</p>
          <p className="text-lg font-semibold mt-1 tabular-nums">
            {formatMoney(data.balance?.pending_cents, cur)}
          </p>
        </div>
      </div>
    </section>
  )
}

export function HostPayoutList() {
  const data = useContext(PayoutsContext)
  if (!data) return null
  const payouts = Array.isArray(data.payouts) ? data.payouts : []
  return (
    <section className="mt-8">
      <h2 className={`${HOST_EYEBROW} mb-3`}>Payouts</h2>
      {payouts.length === 0 ? (
        <p className={HOST_HINT}>No payouts yet.</p>
      ) : (
        <ul className={`${HOST_LIST} overflow-hidden`}>
          {payouts.map((p) => {
            const chip = PAYOUT_STATUS_CHIP[p.status] || `${HOST_CHIP} ${HOST_CHIP_TONE.neutral}`
            return (
              <li key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-4 text-sm">
                <span className="text-host-hint">{formatUnixDate(p.arrival_date)}</span>
                <span className="flex items-center gap-3">
                  <span className="font-medium tabular-nums">{formatMoney(p.amount, p.currency)}</span>
                  <span className={chip}>
                    {PAYOUT_STATUS_LABEL[p.status] || p.status}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

'use client'

// HOST-PORTAL.12 — host payout/balance visibility. Self-fetching section for
// the host dashboard: Stripe balance (Available / On the way) + the last few
// payouts, read from /api/host/stripe/payouts. Graceful-degrade contract: the
// route returns data:null for non-Stripe hosts or ANY Stripe failure, and this
// component renders NOTHING in that case (or on fetch error) — the dashboard
// must never gain a broken section because Stripe is unreachable.
//
// Dark UN1T host-portal styling (bg-black page) — dark-surface chip recipe
// `bg-<c>-500/15 text-<c>-300`; host paths are exempt from the light-theme
// -700 chip rule.

import { createContext, useContext, useEffect, useState } from 'react'

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

// Dark-surface payout status chips (paid = money landed; pending/in_transit =
// on the way; failed/canceled = needs the host's attention in Stripe).
const PAYOUT_STATUS_CHIP = {
  paid: 'bg-emerald-500/15 text-emerald-300',
  pending: 'bg-amber-500/15 text-amber-300',
  in_transit: 'bg-amber-500/15 text-amber-300',
  failed: 'bg-red-500/15 text-red-300',
  canceled: 'bg-red-500/15 text-red-300',
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
      <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Balance</h2>
      <div className="grid grid-cols-2 gap-3 max-w-md">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-white/40">Available</p>
          <p className="text-lg font-semibold mt-1 tabular-nums">
            {formatMoney(data.balance?.available_cents, cur)}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-white/40">On the way</p>
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
      <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Payouts</h2>
      {payouts.length === 0 ? (
        <p className="text-white/50 text-sm">No payouts yet.</p>
      ) : (
        <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
          {payouts.map((p) => {
            const chip = PAYOUT_STATUS_CHIP[p.status] || 'bg-white/10 text-white/70'
            return (
              <li key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-4 text-sm">
                <span className="text-white/60">{formatUnixDate(p.arrival_date)}</span>
                <span className="flex items-center gap-3">
                  <span className="font-medium tabular-nums">{formatMoney(p.amount, p.currency)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${chip}`}>
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

// Default export kept until the dashboard stops importing it (Task 7).
export default function HostPayouts() {
  return (
    <HostPayoutsProvider>
      <HostBalance />
      <HostPayoutList />
    </HostPayoutsProvider>
  )
}

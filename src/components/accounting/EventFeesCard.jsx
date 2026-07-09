'use client'

// HOST-PORTAL.8 — Event booking fees card on /accounting. Org-wide
// rollup of the per-ticket booking fee UN1T earned on host events
// (race_payments.application_fee_cents, settled rows only): headline
// total, per-host table, per-month mini-list. Fetch/loading pattern
// mirrors HuntInboxesCard; unlike it, an error (e.g. 403) renders
// NOTHING — the card collapses rather than showing a broken box on a
// page whose other cards still work.

import { useCallback, useEffect, useState } from 'react'
import { Loading } from '@/components/ui'

const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
const fmtCents = (cents) => eur.format((Number(cents) || 0) / 100)

export default function EventFeesCard() {
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/accounting/event-fees')
      const json = await res.json()
      if (!json.success) { setFailed(true); return }
      setData(json.data)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (failed) return null

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold text-un1t-text">Event booking fees</div>
        <p className="text-xs text-un1t-subtle mt-1">
          The per-ticket booking fee UN1T earned on hosted events, across every host in this
          organisation. Settled payments only; Revolut/internal bookings carry no fee.
        </p>
      </div>

      {data === null ? (
        <Loading />
      ) : data.paidCount === 0 ? (
        <div className="text-xs text-un1t-subtle">No event fees yet.</div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="text-2xl font-semibold text-un1t-text">{fmtCents(data.total_fee_cents)}</div>
            <div className="text-xs text-un1t-subtle">
              from {data.paidCount} paid booking{data.paidCount === 1 ? '' : 's'}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-un1t-subtle">
                  <th className="py-1.5 pr-3 font-semibold">Host</th>
                  <th className="py-1.5 pr-3 font-semibold text-right">Paid bookings</th>
                  <th className="py-1.5 font-semibold text-right">Fees</th>
                </tr>
              </thead>
              <tbody>
                {(data.perHost || []).map((h) => (
                  <tr key={h.host_id} className="border-t border-un1t-border/50">
                    <td className="py-1.5 pr-3 text-un1t-text">{h.name}</td>
                    <td className="py-1.5 pr-3 text-right text-un1t-text">{h.paidCount}</td>
                    <td className="py-1.5 text-right text-un1t-text">{fmtCents(h.fee_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(data.perMonth || []).length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-1.5">
                By month
              </div>
              <div className="space-y-1">
                {data.perMonth.map((m) => (
                  <div key={m.month} className="flex items-center justify-between text-xs">
                    <span className="text-un1t-subtle">{m.month}</span>
                    <span className="text-un1t-text">{fmtCents(m.fee_cents)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

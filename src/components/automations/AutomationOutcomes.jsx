'use client'

// SEQOUTCOME.1 — "What happened next" for an automation: in the 7 days after
// someone clicked one of its emails, how many booked a class, registered for
// an event or bought something, beside the people sent its emails who never
// opened or clicked one. Reads /api/sequences/[id]/outcomes; renders nothing
// until there is an answer, and nothing on a refusal.

import { useEffect, useState } from 'react'

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—')
const euro = (c) => `€${(Number(c || 0) / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`

export default function AutomationOutcomes({ sequenceId }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let alive = true
    fetch(`/api/sequences/${sequenceId}/outcomes`)
      .then((r) => r.json())
      .then((d) => { if (alive && d?.success) setData(d.data) })
      .catch(() => {})
    return () => { alive = false }
  }, [sequenceId])

  if (!data || (data.clicked.contacts === 0 && data.not_opened.contacts === 0)) return null
  const rows = [
    ['Booked a class', 'class_attendances'],
    ['Registered for an event', 'event_registrations'],
    ['Bought something', 'purchases'],
  ]
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-un1t-text mb-1">What happened next</h3>
      <p className="text-xs text-un1t-subtle mb-2">
        Within {data.window_days} days of clicking one of this automation&apos;s emails, beside people it emailed who never
        opened or clicked. Memberships paid by direct debit are not counted.
      </p>
      <div className="overflow-x-auto rounded-lg border border-un1t-border">
        <table className="w-full text-sm">
          <thead className="text-xs text-un1t-subtle">
            <tr className="border-b border-un1t-border">
              <th className="text-left font-medium px-3 py-2"></th>
              <th className="text-right font-medium px-3 py-2">Clicked ({data.clicked.contacts.toLocaleString()})</th>
              <th className="text-right font-medium px-3 py-2">Never opened ({data.not_opened.contacts.toLocaleString()})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, key]) => (
              <tr key={key} className="border-b border-un1t-border/60 last:border-0">
                <td className="px-3 py-2 text-un1t-text">{label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{data.clicked[key].toLocaleString()} <span className="text-un1t-subtle">· {pct(data.clicked[key], data.clicked.contacts)}</span></td>
                <td className="px-3 py-2 text-right tabular-nums">{data.not_opened[key].toLocaleString()} <span className="text-un1t-subtle">· {pct(data.not_opened[key], data.not_opened.contacts)}</span></td>
              </tr>
            ))}
            <tr>
              <td className="px-3 py-2 text-un1t-text">Spent</td>
              <td className="px-3 py-2 text-right tabular-nums">{euro(data.clicked.purchase_cents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{euro(data.not_opened.purchase_cents)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

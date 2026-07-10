'use client'

// HOST-PORTAL.13 — monthly statements. Self-fetching section for the host
// dashboard: lists the months with settled ticket activity (from
// /api/host/statements) with a per-month CSV download link (same route,
// ?month=YYYY-MM). Graceful-degrade contract mirrors HostPayouts: no months,
// fetch error, or still loading → render NOTHING — the dashboard never gains
// a broken/empty section.
//
// Dark UN1T host-portal styling (bg-black page).

import { useEffect, useState } from 'react'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// '2026-07' → 'July 2026'. Pure string math — no Date, no TZ.
function monthLabel(month) {
  const [y, m] = String(month || '').split('-')
  return MONTH_NAMES[Number(m) - 1] ? `${MONTH_NAMES[Number(m) - 1]} ${y}` : month
}

export default function HostStatements() {
  const [months, setMonths] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/host/statements', { cache: 'no-store' })
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok && json.success && Array.isArray(json.data?.months)) {
          setMonths(json.data.months)
        }
      } catch {
        // Render nothing on network failure — same posture as no months.
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (months.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-3">Statements</h2>
      <ul className="divide-y divide-white/10 rounded-xl border border-white/10 overflow-hidden">
        {months.map((m) => (
          <li key={m} className="px-4 py-2.5 flex items-center justify-between gap-4 text-sm">
            <span className="text-white/60">{monthLabel(m)}</span>
            <a
              href={`/api/host/statements?month=${encodeURIComponent(m)}`}
              className="text-xs text-white/50 hover:text-white"
            >
              Download CSV
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

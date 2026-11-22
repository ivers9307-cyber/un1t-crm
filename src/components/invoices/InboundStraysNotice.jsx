'use client'

// INVOICEPREP.1 — masters only: inbound invoice emails that matched no studio,
// so they never reached any queue. Hidden when there are none or the read
// fails (a notice, not a page that can break).

import { useEffect, useState } from 'react'

const REASONS = {
  unknown_slug: 'No studio uses this address',
  unparseable_recipient: 'Address not recognised',
}

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function InboundStraysNotice() {
  const [rows, setRows] = useState([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/invoices-inbox/strays')
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.success && Array.isArray(j.data)) setRows(j.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-700"
      >
        {rows.length === 1 ? '1 email could not be matched to a studio' : `${rows.length} emails could not be matched to a studio`}
      </button>
      {open && (
        <ul className="border border-un1t-border rounded-lg divide-y divide-un1t-border bg-un1t-surface">
          {rows.map((r) => (
            <li key={r.id} className="p-3 text-sm space-y-0.5">
              <p className="text-un1t-text">{r.subject || '(no subject)'}</p>
              <p className="text-xs text-un1t-subtle">To <span>{r.to_address}</span></p>
              <p className="text-xs text-un1t-subtle">From <span>{r.from_address}</span></p>
              <p className="text-xs text-un1t-subtle">
                <span>{REASONS[r.reason] || r.reason}</span> · <span>{formatDateTime(r.received_at)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

'use client'

// APPROVALSQ.2 — the bar and the single confirm for clearing several Mia
// requests at once on /approvals. Each request is the same quiet clear a card
// sends on its own (PATCH status 'declined' + silent: true), one after another
// through the route, so the route's own permission check and 409 handling
// apply to every one. Nothing here sends a message to a customer.

import { useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { bookingWarningCount, runBulkClear } from '@/lib/approvals/bulk-clear'

async function clearOne(id, note) {
  const res = await fetch(`/api/agent/membership-requests/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'declined', silent: true, decision_note: note || null }),
  })
  const json = await res.json()
  return { ok: !!(res.ok && json?.success) }
}

// `items` are the selected Mia items in list order. `onFinished({ cleared,
// failed })` runs once when every request has been tried.
export default function BulkClearBar({ items, onSelectAll, onCancel, onFinished }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [note, setNote] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const inFlight = useRef(false)

  const n = items.length
  const told = bookingWarningCount(items)
  // The selection can empty under an open confirm (a chip switch): nothing to confirm.
  const showConfirm = confirmOpen && (n > 0 || running)

  async function confirm() {
    if (inFlight.current || n === 0) return
    inFlight.current = true
    setRunning(true)
    setProgress(0)
    const ids = items.map((i) => i.id)
    let counter = 0
    let result = { cleared: [], failed: [] }
    try {
      result = await runBulkClear(ids, {
        note: note.trim() || null,
        clearOne: (id, text) => {
          counter += 1
          setProgress(counter)
          return clearOne(id, text)
        },
      })
    } finally {
      inFlight.current = false
      setRunning(false)
      setConfirmOpen(false)
      setNote('')
      onFinished?.(result)
    }
  }

  return (
    <div className="border border-un1t-border rounded-lg p-3 bg-un1t-surface space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-un1t-text mr-2">
          {running ? `Clearing ${progress} of ${n}` : `${n} selected`}
        </span>
        <Button type="button" size="sm" variant="secondary" disabled={running} onClick={onSelectAll}>
          Select all
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={running || n === 0} onClick={() => setConfirmOpen(true)}>
          Clear, don&apos;t notify
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={running} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {showConfirm && (
        <div className="border border-un1t-border rounded-md p-3 space-y-3 bg-un1t-bg/40">
          <p className="text-sm font-medium text-un1t-text">
            Clear {n} requests without telling the customers?
          </p>
          {told > 0 && (
            <p className="text-sm rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">
              Mia told {told} of these customers the team would confirm. Clearing sends them nothing.
            </p>
          )}
          <input
            type="text"
            value={note}
            disabled={running}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="w-full text-sm border border-un1t-border rounded-md px-3 py-2 bg-un1t-surface text-un1t-text"
          />
          <div className="flex gap-2 flex-wrap">
            <Button type="button" size="sm" disabled={running} onClick={confirm}>
              Clear {n}, don&apos;t notify
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={running} onClick={() => setConfirmOpen(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

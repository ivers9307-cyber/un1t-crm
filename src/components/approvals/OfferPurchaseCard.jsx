'use client'

// APPROVALSQ.1 — a paid offer sale that still needs setting up, on the
// /approvals queue. Mark fulfilled POSTs /api/offer-purchases/[id]/fulfil,
// which emails the buyer; the route answers { fulfilled, emailed } (or
// { already: true } if someone got there first), and the outcome says which.
import { useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'
import CustomerCardShell from './CustomerCardShell'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function OfferPurchaseCard({ item, onDecided }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { tone, text }
  const inFlight = useRef(false)

  async function fulfil() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setOutcome(null)
    try {
      const r = await fetch(`/api/offer-purchases/${item.id}/fulfil`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setOutcome({ tone: 'bad', text: `Could not mark it fulfilled (${j.error || `HTTP ${r.status}`}).` })
        return
      }
      if (j.data?.already) {
        setOutcome({ tone: 'neutral', text: 'Already marked fulfilled. No email was sent this time.' })
      } else if (j.data?.emailed) {
        setOutcome({ tone: 'ok', text: 'Marked fulfilled. The buyer has been emailed.' })
      } else {
        setOutcome({ tone: 'ok', text: 'Marked fulfilled. The confirmation email did not send. Use Send confirmation on the offer sales page.' })
      }
      onDecided?.()
    } catch (e) {
      setOutcome({ tone: 'bad', text: e.message || 'Network error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const done = outcome && outcome.tone !== 'bad'
  return (
    <CustomerCardShell
      source="OFFER SALE"
      state={{ label: 'Paid, not set up', tone: 'amber' }}
      name={item.title}
      meta={item.meta}
      when={`Paid ${formatDateTime(item.submittedAt)}`}
      amount={`€${Number(item.amount || 0).toFixed(2)}`}
      summary={item.subtitle}
      links={item.reviewUrl && <Link href={item.reviewUrl} className="underline text-un1t-subtle">Open offer sales</Link>}
      outcome={outcome}
      actions={!done && (
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={fulfil}>
          Mark fulfilled (emails buyer)
        </Button>
      )}
    />
  )
}

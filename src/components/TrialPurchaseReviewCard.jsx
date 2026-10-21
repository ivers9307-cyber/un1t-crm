'use client'

// PAIDTRIAL.2 — a paid trial purchase whose Glofox grant needs a hand, on
// the /approvals "Paid trials" tab. The money is in; the plan is not on the
// account. Two ways out, both through POST /api/trial-purchases/[id]/review:
//   Retry grant   the processor runs again (a purchase Glofox never answered
//                 is never bought twice; such a row comes back and wants the
//                 other button once staff have checked Glofox).
//   Mark granted  staff put the plan on in Glofox by hand; the buyer gets the
//                 confirmation email.

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function TrialPurchaseReviewCard({ item, onDecided }) {
  const [busy, setBusy] = useState(null) // 'retry' | 'resolve'
  const [outcome, setOutcome] = useState(null) // { ok, text }

  async function act(action) {
    setBusy(action)
    setOutcome(null)
    try {
      const r = await fetch(`/api/trial-purchases/${item.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        const code = j.error || `HTTP ${r.status}`
        const text = code === 'in_progress'
          ? 'The processor is already working on this one. Refresh in a minute.'
          : code === 'not_paid'
            ? 'This purchase has no settled payment, so there is nothing to grant.'
            : `Could not ${action === 'retry' ? 'retry' : 'mark it granted'} (${code}).`
        setOutcome({ ok: false, text })
        return
      }
      if (action === 'retry') {
        setOutcome({ ok: true, text: 'Back in the queue. The grant runs within two minutes; if Glofox refuses again this card returns.' })
      } else {
        setOutcome({ ok: true, text: j.data?.emailed ? 'Marked granted. The buyer has been emailed.' : 'Marked granted. The confirmation email was not sent (no address, or opted out).' })
      }
      onDecided?.()
    } catch (e) {
      setOutcome({ ok: false, text: e.message || 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  const done = outcome?.ok
  return (
    <div className="border border-un1t-border rounded-lg p-4 bg-un1t-surface space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-un1t-text">{item.title}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/10 text-red-700">Grant failed</span>
            {item.meta && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-un1t-border/30 text-un1t-subtle border border-un1t-border">{item.meta}</span>
            )}
          </div>
          <div className="text-xs text-un1t-subtle mt-1">{item.subtitle}</div>
          <div className="text-xs text-un1t-subtle mt-1">
            Paid {formatDateTime(item.submittedAt)}
            {item.attempts > 1 ? ` · ${item.attempts} attempts` : ''}
          </div>
        </div>
        <div className="text-sm font-medium text-un1t-text tabular-nums">€{Number(item.amount || 0).toFixed(2)}</div>
      </div>

      <p className="text-sm text-un1t-text">{item.why}</p>
      {item.mayHaveLanded && (
        <p className="text-xs text-amber-700">
          Check the member&apos;s invoices in Glofox before retrying: the plan may already be on the account.
        </p>
      )}

      <div className="text-xs text-un1t-subtle flex flex-wrap gap-x-4 gap-y-1">
        {item.email && <span>{item.email}</span>}
        {item.phone && <span>{item.phone}</span>}
        {item.glofoxMemberId && <span>Glofox member {item.glofoxMemberId}</span>}
        {item.contactId && <Link href={`/contacts/${item.contactId}`} className="underline">Open contact</Link>}
      </div>

      {outcome && (
        <div className={`text-sm rounded-md px-3 py-2 ${outcome.ok ? 'bg-green-500/10 text-green-700' : 'bg-red-500/10 text-red-700'}`}>
          {outcome.text}
        </div>
      )}

      {!done && (
        <div className="flex gap-2 flex-wrap">
          <Button type="button" size="sm" variant="primary" loading={busy === 'retry'} disabled={!!busy} onClick={() => act('retry')}>
            Retry grant
          </Button>
          <Button type="button" size="sm" variant="secondary" loading={busy === 'resolve'} disabled={!!busy} onClick={() => act('resolve')}>
            Mark granted in Glofox
          </Button>
        </div>
      )}
    </div>
  )
}

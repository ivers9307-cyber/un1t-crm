'use client'

// CORPPROMO.1 — a /corp promo claim whose free credits could not be put on
// the person's un1t.online account, on the /approvals "Corporate promos" tab.
// Nobody was charged. Staff check the account in un1t.online, add the credits
// by hand if the person qualifies, then Mark handled
// (POST /api/corp-promo-claims/[id]/handled).
import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function CorpPromoClaimCard({ item, onDecided }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { ok, text }

  async function markHandled() {
    setBusy(true)
    setOutcome(null)
    try {
      const r = await fetch(`/api/corp-promo-claims/${item.id}/handled`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setOutcome({ ok: false, text: `Could not mark it handled (${j.error || `HTTP ${r.status}`}).` })
        return
      }
      setOutcome({ ok: true, text: 'Marked handled.' })
      onDecided?.()
    } catch (e) {
      setOutcome({ ok: false, text: e.message || 'Network error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border border-un1t-border rounded-lg p-4 bg-un1t-surface space-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-un1t-text">{item.title}</span>
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700">Credits not added</span>
          {item.meta && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-un1t-border/30 text-un1t-subtle border border-un1t-border">{item.meta}</span>
          )}
        </div>
        <div className="text-xs text-un1t-subtle mt-1">{item.subtitle}</div>
        <div className="text-xs text-un1t-subtle mt-1">Claimed {formatDateTime(item.submittedAt)}</div>
      </div>

      <p className="text-sm text-un1t-text">{item.why}</p>

      <div className="text-xs text-un1t-subtle flex flex-wrap gap-x-4 gap-y-1">
        {item.email && <span>{item.email}</span>}
        {item.phone && <span>{item.phone}</span>}
        {item.un1tUserId && <span>un1t.online user {item.un1tUserId}</span>}
        {item.contactId && <Link href={`/contacts/${item.contactId}`} className="underline">Open contact</Link>}
      </div>

      {outcome && (
        <div className={`text-sm rounded-md px-3 py-2 ${outcome.ok ? 'bg-green-500/10 text-green-700' : 'bg-red-500/10 text-red-700'}`}>
          {outcome.text}
        </div>
      )}

      {!outcome?.ok && (
        <div className="flex gap-2 flex-wrap">
          <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={markHandled}>
            Mark handled
          </Button>
        </div>
      )}
    </div>
  )
}

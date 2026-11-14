'use client'

// CORPPROMO.1 — a /corp promo claim whose free credits could not be put on
// the person's un1t.online account, on the /approvals "Corporate promos" tab.
// Nobody was charged. Staff check the account in un1t.online, add the credits
// by hand if the person qualifies, then Mark handled
// (POST /api/corp-promo-claims/[id]/handled).
// APPROVALSQ.1 — laid out on CustomerCardShell.
import { useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'
import CustomerCardShell from '@/components/approvals/CustomerCardShell'
import { withStudio, studioChip } from '@/lib/approvals/studio-request'
import { formatApprovalDateTime } from '@/components/approvals/format-date-time'

export default function CorpPromoClaimCard({ item, onDecided, timezone = null, activeStudioId = null }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { tone, text }
  const inFlight = useRef(false)

  async function markHandled() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setOutcome(null)
    try {
      const r = await fetch(`/api/corp-promo-claims/${item.id}/handled`, withStudio(item, { method: 'POST' }))
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setOutcome({ tone: 'bad', text: `Could not mark it handled (${j.error || `HTTP ${r.status}`}).` })
        return
      }
      setOutcome({ tone: 'ok', text: 'Marked handled.' })
      onDecided?.()
    } catch (e) {
      setOutcome({ tone: 'bad', text: e.message || 'Network error' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <CustomerCardShell
      source="CORPORATE PROMO"
      state={{ label: 'Credits not added', tone: 'amber' }}
      name={item.title}
      studio={studioChip(item, activeStudioId)}
      meta={item.meta}
      when={`Claimed ${formatApprovalDateTime(item.submittedAt, timezone)}`}
      summary={item.subtitle}
      contact={(
        <>
          {item.email && <span>{item.email}</span>}
          {item.phone && <span>{item.phone}</span>}
          {item.glofoxMemberId && <span>Glofox member {item.glofoxMemberId}</span>}
          {item.un1tUserId && <span>un1t.online user {item.un1tUserId}</span>}
          {item.contactId && <Link href={`/contacts/${item.contactId}`} className="underline">Open contact</Link>}
        </>
      )}
      outcome={outcome}
      actions={outcome?.tone !== 'ok' && (
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={markHandled}>
          Mark handled
        </Button>
      )}
    >
      <p className="text-sm text-un1t-text">{item.why}</p>
    </CustomerCardShell>
  )
}

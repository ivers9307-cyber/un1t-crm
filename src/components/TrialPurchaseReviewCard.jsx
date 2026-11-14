'use client'

// PAIDTRIAL.2 — a paid trial purchase whose Glofox grant needs a hand, on
// the /approvals "Paid trials" tab. The money is in; the plan is not on the
// account. Two ways out, both through POST /api/trial-purchases/[id]/review:
//   Retry grant   the processor runs again (a purchase Glofox never answered
//                 is never bought twice; such a row comes back and wants the
//                 other button once staff have checked Glofox).
//   Mark granted  staff put the plan on in Glofox by hand; the buyer gets the
//                 confirmation email.
// A second kind of card (TRIALSTUDIO.8, item.kind === 'help'): the buyer was
// never charged and asked for a call (refused for a past trial or an active
// membership, or un1t.online could not give them an account/checkout). One
// button, Mark handled, once staff have rung them; no email goes out.
// APPROVALSQ.1 — laid out on CustomerCardShell; a grant card also has a quiet
// third button, Mark granted with no email ({ action: 'resolve', notify: false }).

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui'
import CustomerCardShell from '@/components/approvals/CustomerCardShell'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

export default function TrialPurchaseReviewCard({ item, onDecided }) {
  const [busy, setBusy] = useState(null) // 'retry' | 'resolve' | 'quiet' | 'handled'
  const [outcome, setOutcome] = useState(null) // { tone, text }
  const inFlight = useRef(false)

  // `which` names the button (for the spinner); `action` + `notify` are the body.
  async function act(which, action, notify) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(which)
    setOutcome(null)
    try {
      const r = await fetch(`/api/trial-purchases/${item.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notify === false ? { action, notify: false } : { action }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        const code = j.error || `HTTP ${r.status}`
        const text = code === 'in_progress'
          ? 'The processor is already working on this one. Refresh in a minute.'
          : code === 'not_paid'
            ? 'This purchase has no settled payment, so there is nothing to grant.'
            : `Could not ${action === 'retry' ? 'retry' : action === 'handled' ? 'mark it handled' : 'mark it granted'} (${code}).`
        setOutcome({ tone: 'bad', text })
        return
      }
      if (action === 'handled') {
        setOutcome({ tone: 'ok', text: 'Marked handled.' })
      } else if (action === 'retry') {
        setOutcome({ tone: 'ok', text: 'Back in the queue. The grant runs within two minutes; if Glofox refuses again this card returns.' })
      } else if (notify === false) {
        setOutcome({ tone: 'ok', text: 'Marked granted. No email was sent.' })
      } else {
        setOutcome({ tone: 'ok', text: j.data?.emailed ? 'Marked granted. The buyer has been emailed.' : 'Marked granted. The confirmation email was not sent (no address, or opted out).' })
      }
      onDecided?.()
    } catch (e) {
      setOutcome({ tone: 'bad', text: e.message || 'Network error' })
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const done = outcome?.tone === 'ok'
  const help = item.kind === 'help'

  let actions = null
  let quietAction = null
  if (!done && help) {
    actions = (
      <Button type="button" size="sm" variant="primary" loading={busy === 'handled'} disabled={!!busy} onClick={() => act('handled', 'handled')}>
        Mark handled
      </Button>
    )
  } else if (!done) {
    actions = (
      <>
        <Button type="button" size="sm" variant="primary" loading={busy === 'retry'} disabled={!!busy} onClick={() => act('retry', 'retry')}>
          Retry grant
        </Button>
        <Button type="button" size="sm" variant="secondary" loading={busy === 'resolve'} disabled={!!busy} onClick={() => act('resolve', 'resolve')}>
          Mark granted in Glofox
        </Button>
      </>
    )
    quietAction = (
      <Button type="button" size="sm" variant="secondary" loading={busy === 'quiet'} disabled={!!busy} onClick={() => act('quiet', 'resolve', false)}>
        Mark granted, no email
      </Button>
    )
  }

  return (
    <CustomerCardShell
      source="PAID TRIAL"
      state={help ? { label: 'Needs a call', tone: 'amber' } : { label: 'Grant failed', tone: 'red' }}
      name={item.title}
      meta={item.meta}
      when={`${help ? 'Asked' : 'Paid'} ${formatDateTime(item.submittedAt)}${!help && item.attempts > 1 ? ` · ${item.attempts} attempts` : ''}`}
      amount={help ? undefined : `€${Number(item.amount || 0).toFixed(2)}`}
      summary={item.subtitle}
      contact={(
        <>
          {item.email && <span>{item.email}</span>}
          {item.phone && <span>{item.phone}</span>}
          {!help && item.glofoxMemberId && <span>Glofox member {item.glofoxMemberId}</span>}
          {item.contactId && <Link href={`/contacts/${item.contactId}`} className="underline">Open contact</Link>}
        </>
      )}
      outcome={outcome}
      actions={actions}
      quietAction={quietAction}
    >
      <p className="text-sm text-un1t-text">{item.why}</p>
      {help && item.reasons?.length > 0 && (
        <ul className="text-xs text-un1t-subtle list-disc pl-4 space-y-0.5">
          {item.reasons.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}
      {!help && item.mayHaveLanded && (
        <p className="text-xs text-amber-700">
          Check the member&apos;s invoices in Glofox before retrying: the plan may already be on the account.
        </p>
      )}
    </CustomerCardShell>
  )
}

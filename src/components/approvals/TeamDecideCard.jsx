'use client'

// APPROVALSQ.4 — one card for a team-and-money item that is decided in place on
// /approvals. The provider's TEAM_ACTIONS entry says which route each button
// calls; this component owns only the presses: one request per press (in-flight
// ref), Decline always through a small panel, an optional confirm before an
// approve that gives something back, and the route's own words on failure.
// No <form>: every button is type="button".
import { useRef, useState } from 'react'
import { Button } from '@/components/ui'
import { TEAM_ACTIONS } from '@/lib/approvals/team-actions'
import { studioChip, metaIsPlace } from '@/lib/approvals/studio-request'
import CustomerCardShell from './CustomerCardShell'
import StudioLink from './StudioLink'
import { formatApprovalDateTime } from './format-date-time'
import { formatAmount } from './format-amount'

// An action may define approvedTextWithWarnings / declinedTextWithWarnings: the
// outcome shown when the success answer carried warnings, so the sentence never
// asserts what a warning denies. Default is the bare word.
function outcomeText(cfg, kind, warned) {
  if (kind === 'approve') return warned ? (cfg.approvedTextWithWarnings || 'Approved.') : cfg.approvedText
  return warned ? (cfg.declinedTextWithWarnings || 'Declined.') : cfg.declinedText
}

// Every warning a success answer carries: `warnings` (array) and/or `warning`.
function answerWarnings(body) {
  const out = []
  if (Array.isArray(body?.warnings)) for (const w of body.warnings) if (typeof w === 'string' && w.trim()) out.push(w)
  if (typeof body?.warning === 'string' && body.warning.trim()) out.push(body.warning)
  return out
}

export default function TeamDecideCard({
  item, providerKey, providerLabel, timezone = null, onDecided, extra, activeStudioId = null,
  approveDisabledReason, afterApprove, onApproveFailure,
}) {
  const cfg = TEAM_ACTIONS[providerKey]
  const [mode, setMode] = useState('idle') // 'idle' | 'confirm' | 'decline'
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null) // { text, node, warnings }
  const [failureNode, setFailureNode] = useState(null) // set by onApproveFailure
  const inFlight = useRef(false)

  // `perform` is the request this press makes; it returns a Result. Shared by
  // the Approve and Decline buttons and by a follow-up step (approveAgain).
  async function settle(kind, perform) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await perform()
      if (!result?.ok) {
        // A card may take over a failed approve with its own step (a swap
        // conflict). The node replaces the generic error line; it gets the
        // result and controls to run another approve or go back.
        const node = kind === 'approve' && onApproveFailure
          ? onApproveFailure(result, { approveAgain, dismiss: () => setFailureNode(null) })
          : null
        if (node) {
          setFailureNode(node)
        } else {
          setFailureNode(null)
          setError(result?.error || 'Something went wrong. Please try again.')
        }
        if (kind === 'approve') setMode('idle')
        return
      }
      setFailureNode(null)
      const warnings = answerWarnings(result.body)
      setDone({
        text: outcomeText(cfg, kind, warnings.length > 0),
        warnings,
        node: kind === 'approve' && afterApprove ? afterApprove(result) : null,
      })
      onDecided?.()
    } catch (e) {
      setError(e?.message || 'Something went wrong. Please try again.')
      if (kind === 'approve') setMode('idle')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function approveAgain(perform) { return settle('approve', perform) }

  const blocked = typeof approveDisabledReason === 'string' && approveDisabledReason.length > 0

  function run(kind) {
    if (kind === 'approve' && blocked) return undefined
    return settle(kind, () => (kind === 'approve' ? cfg.approve(item) : cfg.decline(item, reason.trim() || null)))
  }

  function pressApprove() {
    if (blocked) return
    if (cfg.approveConfirm) { setError(null); setMode('confirm'); return }
    run('approve')
  }

  const reasonMissing = cfg.reasonRequired && !reason.trim()
  const amount = formatAmount(item.amount, item.currency)

  let actions
  if (done) {
    actions = done.node || null
  } else if (failureNode) {
    actions = null
  } else if (mode === 'confirm') {
    actions = (
      <>
        <span className="text-sm text-un1t-text">{cfg.approveConfirm}</span>
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy} onClick={() => run('approve')}>Confirm</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setMode('idle')}>Back</Button>
      </>
    )
  } else if (mode === 'decline') {
    const inputId = `decline-reason-${providerKey}-${item.id}`
    actions = (
      <>
        <label htmlFor={inputId} className="text-xs text-un1t-subtle">{cfg.reasonLabel}</label>
        <input
          id={inputId}
          type="text"
          value={reason}
          maxLength={1000}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          className="flex-1 min-w-[200px] text-sm bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-un1t-text"
        />
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy || reasonMissing} onClick={() => run('decline')}>Confirm</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setMode('idle'); setError(null) }}>Back</Button>
      </>
    )
  } else {
    actions = (
      <>
        <Button type="button" size="sm" variant="primary" loading={busy} disabled={busy || blocked} onClick={pressApprove}>{cfg.approveLabel}</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setError(null); setMode('decline') }}>{cfg.declineLabel}</Button>
        {blocked && <span className="text-xs text-un1t-subtle">{approveDisabledReason}</span>}
      </>
    )
  }

  return (
    <CustomerCardShell
      source={providerLabel}
      name={item.title}
      studio={studioChip(item, activeStudioId)}
      meta={item.meta}
      metaIsPlace={metaIsPlace(providerKey)}
      when={`Submitted ${formatApprovalDateTime(item.submittedAt, timezone)}`}
      amount={amount}
      summary={item.subtitle}
      links={item.reviewUrl && <StudioLink item={item} activeStudioId={activeStudioId} href={item.reviewUrl} className="underline text-un1t-subtle">Open in {cfg.pageLabel}</StudioLink>}
      outcome={done ? { tone: 'ok', text: done.text } : null}
      error={error}
      actions={actions}
    >
      {item.warning && <div className="text-xs rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">{item.warning}</div>}
      {done?.warnings?.map((w, i) => (
        <div key={i} className="text-xs rounded-md px-3 py-2 bg-amber-500/10 text-amber-700">{w}</div>
      ))}
      {extra}
      {!done && failureNode}
    </CustomerCardShell>
  )
}

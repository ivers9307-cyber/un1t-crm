'use client'

// AGENT-REQ-UX.1 — decidable agent-request card for the /approvals
// Agent requests tab. Previously the tab was a click-through list to
// /settings/customer-agent/requests; now the decision happens in place,
// through the SAME PATCH route as the settings page, the inbox card and
// mobile (atomic pending-claim, Glofox execution on approve, in-thread
// confirmation / decline notice all server-side — identical everywhere).
//
// Also surfaces what the raw list never did: WHY the request was flagged
// (machine codes translated by whyFlagged), what the customer actually
// said, and the contact's email/phone for a quick Glofox lookup.

import { useState } from 'react'
import Link from 'next/link'
import { Sparkles, Copy, Check } from 'lucide-react'
import { DECLINE_REASONS, BOOKING_KINDS } from '@shared/approvals-next-steps'
import { APPROVAL_KIND_LABELS } from '@shared/approval-cards'
import { whyFlagged, customerWords, failureExplanation } from '@/lib/approvals/agent-request-why'
import { EXECUTING_KINDS } from '@/lib/agent/request-recovery'

const KIND_CHIP = {
  cancellation: 'bg-red-500/10 text-red-700',
  class_cancellation: 'bg-red-500/10 text-red-700',
  event_cancellation: 'bg-red-500/10 text-red-700',
  pause: 'bg-amber-500/10 text-amber-700',
}
const DEFAULT_KIND_CHIP = 'bg-amber-500/10 text-amber-700'

function formatDateTime(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return s }
}

function CopyValue({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard unavailable — the value is still visible to select */ }
      }}
      title="Copy"
      className="inline-flex items-center gap-1 text-xs text-un1t-text bg-un1t-bg border border-un1t-border rounded-md px-2 py-0.5 hover:bg-un1t-border/30"
    >
      <span className="select-all">{value}</span>
      {copied ? <Check size={12} className="text-green-700" /> : <Copy size={12} className="text-un1t-subtle" />}
    </button>
  )
}

// What actually happened, in the operator's terms, once the PATCH returns.
function outcomeLine(status, item, executed) {
  const hasThread = !!item.conversationId
  if (status === 'actioned') {
    return { tone: 'ok', text: hasThread ? 'Done — executed in Glofox and the customer was told in-thread.' : 'Done — executed in Glofox and the customer was notified.' }
  }
  if (status === 'failed') {
    // AGENT-RETRY.1 — a failure is a fix-then-retry, not a dead end.
    const explain = failureExplanation({ status: 'failed', details: { result: executed || {} } })
    return { tone: 'bad', failed: true, text: `${explain} The customer has NOT been confirmed.` }
  }
  if (status === 'approved') {
    return { tone: 'ok', text: 'Approved — now make the change in Glofox (this kind is not automated).' }
  }
  if (status === 'declined') {
    return { tone: 'neutral', text: hasThread ? 'Declined — the customer was told in-thread.' : 'Declined. This request has no conversation, so tell the customer yourself if needed.' }
  }
  if (status === 'saved') {
    return { tone: 'ok', text: 'Marked as saved — the member stays.' }
  }
  return { tone: 'neutral', text: status }
}

export default function AgentRequestDecideCard({ item, onDecided }) {
  const [busy, setBusy] = useState(null)       // 'approved' | 'declined' | 'saved' | null
  const [declineOpen, setDeclineOpen] = useState(false)
  const [reason, setReason] = useState(BOOKING_KINDS.has(item.kind) ? 'class_full' : 'other')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [outcome, setOutcome] = useState(null) // { tone, text, failed? } after a decision
  const [countedDecided, setCountedDecided] = useState(false)

  const kindLabel = APPROVAL_KIND_LABELS[item.kind] || 'Agent request'
  const why = whyFlagged(item)
  const said = customerWords(item)
  const reasonOptions = BOOKING_KINDS.has(item.kind)
    ? DECLINE_REASONS
    : DECLINE_REASONS.filter(([k]) => k === 'not_eligible' || k === 'other')

  // AGENT-RETRY.1 — `retry` re-approves a just-failed execution (the route
  // accepts approve on status='failed' for executing kinds); everything
  // else decides at most once per card.
  async function decide(status, { retry = false } = {}) {
    if (busy || (outcome && !retry)) return
    setBusy(status)
    setError(null)
    try {
      const reasonLabel = (DECLINE_REASONS.find(([k]) => k === reason) || [])[1]
      const decision_note = status === 'declined'
        ? [reasonLabel, note.trim() || null].filter(Boolean).join(' — ')
        : (note.trim() || null)
      const res = await fetch(`/api/agent/membership-requests/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, decision_note }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(res.status === 409 ? 'Already decided elsewhere — refresh the list.' : (data.error || 'Decision failed'))
        return
      }
      setDeclineOpen(false)
      setOutcome(outcomeLine(data.request?.status || status, item, data.executed))
      // Only the FIRST decision moves the item out of the pending count —
      // a retry re-decides the same (already-counted) item.
      if (!countedDecided) {
        setCountedDecided(true)
        onDecided?.(item.id, data.request)
      }
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(null)
    }
  }

  const conversationHref = item.conversationId
    ? `/communications/inbox?c=${item.conversationId}&ch=${item.channel === 'instagram' ? 'ig' : 'wa'}`
    : null

  return (
    <div className="border border-un1t-border rounded-lg p-4 bg-un1t-surface">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1 text-[10px] font-semibold text-mia">
            <Sparkles size={11} />
            MIA
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${KIND_CHIP[item.kind] || DEFAULT_KIND_CHIP}`}>
            {kindLabel}
          </span>
          <span className="text-sm font-medium text-un1t-text">{item.contactName || 'Customer'}</span>
          {item.channel && <span className="text-xs text-un1t-muted">via {item.channel}</span>}
        </div>
        <span className="text-xs text-un1t-muted shrink-0">Submitted {formatDateTime(item.submittedAt)}</span>
      </div>

      <p className="text-sm text-un1t-text mt-2">{item.subtitle}</p>

      {why && (
        <p className="text-xs text-un1t-muted mt-1.5">
          <span className="font-semibold text-un1t-text">Why it needs review:</span> {why}
        </p>
      )}
      {said && (
        <p className="text-xs text-un1t-muted mt-1.5 border-l-2 border-un1t-border pl-2">
          <span className="font-semibold text-un1t-text">Customer said:</span> “{said}”
        </p>
      )}

      {(item.contactEmail || item.contactPhone) && (
        <div className="flex items-center gap-2 flex-wrap mt-2.5">
          <span className="text-[10px] uppercase tracking-wide text-un1t-subtle">Glofox lookup</span>
          <CopyValue value={item.contactEmail} />
          <CopyValue value={item.contactPhone} />
        </div>
      )}

      {outcome && (
        <p className={`text-sm mt-3 ${outcome.tone === 'ok' ? 'text-green-700' : outcome.tone === 'bad' ? 'text-red-700' : 'text-un1t-muted'}`}>
          {outcome.text}
        </p>
      )}

      {/* AGENT-RETRY.1 — a failed execution offers a retry in place: the
          operator fixes the problem in Glofox, then re-runs the action. */}
      {outcome?.failed && EXECUTING_KINDS.has(item.kind) && (
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <button type="button" disabled={!!busy} onClick={() => decide('approved', { retry: true })}
            className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
            {busy === 'approved' ? 'Retrying…' : 'Fixed it — retry'}
          </button>
          <Link href={item.reviewUrl} className="text-xs text-un1t-muted underline hover:text-un1t-text">
            Full history
          </Link>
        </div>
      )}

      {!outcome && !declineOpen && (
        <div className="flex items-center gap-2 flex-wrap mt-3">
          <button type="button" disabled={!!busy} onClick={() => decide('approved')}
            className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
            {busy === 'approved' ? 'Approving…' : 'Approve'}
          </button>
          {item.retentionFlagged && item.kind === 'cancellation' && (
            <button type="button" disabled={!!busy} onClick={() => decide('saved')}
              className="text-sm border border-blue-300 text-blue-700 px-3 py-1.5 rounded-md disabled:opacity-50">
              {busy === 'saved' ? 'Saving…' : 'Saved (kept)'}
            </button>
          )}
          <button type="button" disabled={!!busy} onClick={() => { setDeclineOpen(true); setError(null) }}
            className="text-sm border border-un1t-border text-un1t-muted px-3 py-1.5 rounded-md disabled:opacity-50">
            Decline
          </button>
          {conversationHref && (
            <Link href={conversationHref} className="text-xs text-un1t-muted underline hover:text-un1t-text ml-1">
              Open conversation
            </Link>
          )}
          <Link href={item.reviewUrl} className="text-xs text-un1t-muted underline hover:text-un1t-text">
            Full history
          </Link>
        </div>
      )}

      {!outcome && declineOpen && (
        <div className="mt-3 space-y-2 max-w-sm">
          <select value={reason} onChange={(e) => setReason(e.target.value)}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text">
            {reasonOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted" />
          <div className="flex items-center gap-2">
            <button type="button" disabled={!!busy} onClick={() => decide('declined')}
              className="text-sm bg-red-600 text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
              {busy === 'declined' ? 'Declining…' : 'Confirm decline'}
            </button>
            <button type="button" onClick={() => { setDeclineOpen(false); setError(null) }}
              className="text-sm text-un1t-muted hover:text-un1t-text">
              Back
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    </div>
  )
}

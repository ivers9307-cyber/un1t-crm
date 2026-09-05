// src/components/ApprovalActionCard.jsx
//
// INBOX-APPROVALS — an agent approval request rendered inline in a
// WA/IG thread. Pending: summary + customer note + decide buttons.
// Decided: compact status line + rule-based next steps (playbook in
// shared/approvals-next-steps). Decisions go through the same PATCH
// route as /settings/customer-agent/requests, so behaviour (Glofox
// execution, Mia's in-thread confirmation) is identical everywhere.
'use client'

import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { getNextSteps, buildDeclineDraft, DECLINE_REASONS, BOOKING_KINDS } from '@shared/approvals-next-steps'
import { approvalCardSummary, APPROVAL_KIND_LABELS } from '@shared/approval-cards'
import SequencePicker from '@/components/SequencePicker'

const STATUS_CHIP = {
  pending:  'bg-amber-500/10 text-amber-700',
  approved: 'bg-green-500/10 text-green-700',
  actioned: 'bg-green-500/10 text-green-700',
  saved:    'bg-blue-500/10 text-blue-700',
  declined: 'bg-red-500/10 text-red-700',
  failed:   'bg-red-500/10 text-red-700',
}
const STATUS_LABELS = {
  pending: 'Needs approval', approved: 'Approved', actioned: 'Done',
  saved: 'Saved', declined: 'Declined', failed: 'Failed',
}

export default function ApprovalActionCard({
  request, contactId, locationId, contactFirstName,
  onDecided, onPrefillComposer, onOpenBookTab,
}) {
  const [busy, setBusy] = useState(null)          // 'approved' | 'declined' | 'saved' | null
  const [declineOpen, setDeclineOpen] = useState(false)
  const [reason, setReason] = useState(BOOKING_KINDS.has(request.kind) ? 'class_full' : 'other')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [showSequencePicker, setShowSequencePicker] = useState(false)
  const [suggestion, setSuggestion] = useState(null)
  const [suggestLoading, setSuggestLoading] = useState(false)

  // reason reflects local state; after a remount the decline reason resets to the default — accepted tradeoff (see plan Known non-goals), don't re-parse decision_note.
  const ctx = { firstName: contactFirstName, details: request.details, reason }

  // Wave 3: fire-and-forget after a successful decide — its own try/catch so
  // any failure (no key, timeout, HTTP error, empty text) leaves `suggestion`
  // null and never surfaces an error. Decide-time only, never on mount.
  async function fetchSuggestion() {
    try {
      setSuggestLoading(true)
      const res = await fetch(`/api/agent/membership-requests/${request.id}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (data.success && data.suggestion) {
        setSuggestion(data.suggestion)
      }
    } catch {
      // silent — playbook steps already rendered; the AI suggestion is a bonus.
    } finally {
      setSuggestLoading(false)
    }
  }

  const [notified, setNotified] = useState(null)

  async function decide(status) {
    if (busy) return
    setBusy(status)
    setError(null)
    try {
      const reasonLabel = (DECLINE_REASONS.find(([k]) => k === reason) || [])[1]
      const decision_note = status === 'declined'
        ? [reasonLabel, note.trim() || null].filter(Boolean).join(' — ')
        : (note.trim() || null)
      const res = await fetch(`/api/agent/membership-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, decision_note }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Decision failed')
        return
      }
      onDecided?.({ ...request, ...data.request })
      // CANCEL-FORM.5 — whether the member heard about a pause/cancellation decision.
      if (data.customer_notified) setNotified(data.customer_notified)
      fetchSuggestion() // fire-and-forget — never blocks the decision UX
      if (status === 'declined') {
        onPrefillComposer?.(buildDeclineDraft(request.kind, reason, ctx))
      }
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(null)
    }
  }

  function runStep(step) {
    if (step.type === 'composer') onPrefillComposer?.(step.draft)
    else if (step.type === 'book') onOpenBookTab?.()
    else if (step.type === 'sequence') setShowSequencePicker(true)
  }

  const status = request.status
  const decided = status !== 'pending'
  const steps = decided ? getNextSteps(request.kind, status, ctx) : []
  const kindLabel = APPROVAL_KIND_LABELS[request.kind] || 'Agent request'
  // class_full / already_booked only make sense for booking-shaped requests.
  const reasonOptions = BOOKING_KINDS.has(request.kind)
    ? DECLINE_REASONS
    : DECLINE_REASONS.filter(([k]) => k === 'not_eligible' || k === 'other')

  return (
    <div className="flex justify-center my-2">
      <div className="w-full max-w-md bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2.5 text-sm relative">
        {/* Mia eyebrow — every request this card renders originates from
            the agent (see file header); tag it the same way the thread
            itself tags Mia's own messages (WAInbox author tag). */}
        <span className="flex items-center gap-1 text-[10px] font-semibold text-mia mb-1">
          <Sparkles size={11} />
          MIA
        </span>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-un1t-text">{kindLabel}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_CHIP[status] || STATUS_CHIP.pending}`}>
            {STATUS_LABELS[status] || status}
          </span>
        </div>
        <p className="text-un1t-text mt-1">{approvalCardSummary(request)}</p>
        {request.customer_note && (
          <p className="text-xs text-un1t-muted mt-1 border-l-2 border-un1t-border pl-2">“{request.customer_note}”</p>
        )}

        {!decided && !declineOpen && (
          <div className="flex items-center gap-2 mt-2.5">
            <button type="button" disabled={!!busy} onClick={() => decide('approved')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {busy === 'approved' ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" disabled={!!busy} onClick={() => { setDeclineOpen(true); setError(null) }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-un1t-border text-un1t-text hover:bg-un1t-border/30 disabled:opacity-50">
              Decline
            </button>
            {request.retention_flagged && request.kind === 'cancellation' && (
              <button type="button" disabled={!!busy} onClick={() => decide('saved')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 disabled:opacity-50">
                {busy === 'saved' ? 'Saving…' : 'Saved the member'}
              </button>
            )}
          </div>
        )}

        {!decided && declineOpen && (
          <div className="mt-2.5 space-y-2">
            <select value={reason} onChange={e => setReason(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2 py-1.5 text-xs text-un1t-text">
              {reasonOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)"
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted" />
            <div className="flex items-center gap-2">
              <button type="button" disabled={!!busy} onClick={() => decide('declined')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {busy === 'declined' ? 'Declining…' : 'Confirm decline'}
              </button>
              <button type="button" onClick={() => { setDeclineOpen(false); setError(null) }}
                className="px-3 py-1.5 rounded-lg text-xs text-un1t-muted hover:text-un1t-text">
                Back
              </button>
            </div>
          </div>
        )}

        {decided && (
          <div className="mt-1.5 text-xs text-un1t-muted">
            {request.decision_note && <span>{request.decision_note}</span>}
            {request.details?.result?.message_code && status === 'failed' && (
              <span className="text-red-700"> ({request.details.result.message_code})</span>
            )}
            {notified && (
              <span className={notified.sent ? ' text-green-700' : ' text-amber-700'}>
                {notified.sent
                  ? ` Member ${notified.channel === 'email' ? 'emailed' : 'messaged'}.`
                  : notified.reason === 'not_applicable' || notified.reason === 'not_executed' ? '' : ' Member NOT told, please follow up.'}
              </span>
            )}
          </div>
        )}

        {(steps.length > 0 || suggestion || suggestLoading) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-un1t-border/50">
            <span className="text-[10px] uppercase tracking-wide text-un1t-subtle w-full">Next steps</span>
            {steps.map(step => (
              <button key={step.id} type="button" onClick={() => runStep(step)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium bg-un1t-bg border border-un1t-border text-un1t-text hover:bg-un1t-border/30 ${step.type === 'book' ? 'hidden xl:inline-flex' : ''}`}>
                {step.label}
              </button>
            ))}
            {suggestion && (
              <button type="button" title={suggestion} onClick={() => onPrefillComposer?.(suggestion)}
                className="px-2.5 py-1 rounded-full text-xs font-medium bg-un1t-bg border border-mia/40 text-mia hover:bg-un1t-border/30">
                Mia suggests
              </button>
            )}
          </div>
        )}
        {suggestLoading && (
          <p className="text-[10px] text-un1t-subtle mt-1.5">Mia is thinking…</p>
        )}

        {error && <p className="text-xs text-red-700 mt-1.5">{error}</p>}

        {/* opens upward — the card usually sits at the bottom of a scroll-clipped thread */}
        {showSequencePicker && contactId && (
          <div className="absolute left-0 right-0 bottom-full z-10 mb-1">
            <SequencePicker
              contactIds={[contactId]}
              locationId={locationId}
              variant="popover"
              onClose={() => setShowSequencePicker(false)}
              onSuccess={() => setShowSequencePicker(false)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

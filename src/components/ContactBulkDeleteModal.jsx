'use client'

// ContactBulkDeleteModal — confirm + fire bulk delete from the
// contacts table action bar.
//
// Pattern matches ContactEditDeleteActions: type DELETE to confirm
// (single per-contact uses the contact's first name; bulk uses a
// fixed sentinel since "type each name" is impractical and "type
// the count" is too easy to guess in a slip).
//
// Response handling: the API returns a per-row breakdown
// (deleted / blocked / forbidden / missing, plus MAIL-GDPR.1's
// scrub_warnings — deleted, but some mail could not be anonymised).
// The modal stays open after the request so the operator can read
// the breakdown, dismiss it themselves, then refresh the page list.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertTriangle, Trash2, X, CheckCircle2 } from 'lucide-react'
import { scrubIncompleteRows } from '@/lib/scrub-warnings'

const CONFIRM_WORD = 'DELETE'

export default function ContactBulkDeleteModal({ contacts, onClose, onDeleted }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const ids = contacts.map(c => c.id)
  const canSubmit = confirm.trim().toUpperCase() === CONFIRM_WORD && !submitting

  async function fire() {
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch('/api/contacts/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: ids }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Bulk delete failed (${r.status})`)
        return
      }
      setResult(j.data)
      // Tell the parent to clear selection so the next page-refresh
      // doesn't show the doomed-but-not-yet-removed rows highlighted.
      if (onDeleted) onDeleted()
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  function closeAndRefresh() {
    onClose()
    router.refresh()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={() => !submitting && (result ? closeAndRefresh() : onClose())}
    >
      <div
        className="bg-un1t-surface border border-un1t-border rounded-xl max-w-lg w-full max-h-[85vh] overflow-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          {result ? (
            <CheckCircle2 size={20} className="text-emerald-700 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={20} className="text-red-500 mt-0.5 shrink-0" />
          )}
          <div className="flex-1">
            <h3 className="text-base font-semibold text-un1t-text">
              {result ? 'Bulk delete complete' : `Delete ${contacts.length} contact${contacts.length === 1 ? '' : 's'}?`}
            </h3>
            {!result && (
              <p className="text-xs text-un1t-subtle mt-1">This cannot be undone.</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => !submitting && (result ? closeAndRefresh() : onClose())}
            className="text-un1t-subtle hover:text-un1t-text"
            disabled={submitting}
          >
            <X size={16} />
          </button>
        </div>

        {!result && (
          <>
            <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 mb-3">
              <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">Selected</div>
              <ul className="text-xs text-un1t-text space-y-0.5 max-h-32 overflow-auto">
                {contacts.slice(0, 12).map(c => (
                  <li key={c.id}>{c.name || c.email || c.id}</li>
                ))}
                {contacts.length > 12 && (
                  <li className="text-un1t-muted">…and {contacts.length - 12} more</li>
                )}
              </ul>
            </div>
            <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 mb-3 text-[11px] text-un1t-subtle space-y-1">
              <div><strong className="text-un1t-text">Will be deleted:</strong> deals, notes, activities, sequence enrolments, send history.</div>
              <div><strong className="text-un1t-text">Will stay (unlinked):</strong> bookings, orders, race registrations, race payments — revenue history is preserved.</div>
              {/* MAIL-GDPR.1 / #1606 — mail is scrubbed on the same doctrine as
                  WhatsApp (contact-mail-erasure.js): tickets + messages are
                  anonymised in place, attachments are hard-deleted. */}
              <div><strong className="text-un1t-text">Will be redacted:</strong> WhatsApp conversations + messages, and mail (conversations, messages, attachments) — PII (phone, profile name, addresses, subject, message body, media, attachments) is wiped, conversation threads stay for audit (GDPR right-to-erasure).</div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-un1t-subtle mb-1">
                  Type <strong className="text-un1t-text">{CONFIRM_WORD}</strong> to confirm:
                </label>
                <input
                  type="text"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
              </div>
              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2">
                  {error}
                </div>
              )}
              <button
                type="button"
                onClick={fire}
                disabled={!canSubmit}
                className="w-full inline-flex items-center justify-center gap-2 bg-red-600 text-white text-sm font-medium py-2 rounded-md hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {submitting ? 'Deleting…' : `Delete ${contacts.length} contact${contacts.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Deleted" value={result.deleted} tone="emerald" />
              <Stat label="Requested" value={result.requested} tone="muted" />
            </div>

            {result.blocked?.length > 0 && (
              <Section
                title={`Blocked (${result.blocked.length})`}
                hint="WhatsApp history blocks deletion. Merge first, then retry."
                rows={result.blocked}
                tone="amber"
              />
            )}
            {result.forbidden?.length > 0 && (
              <Section
                title={`Skipped — wrong location (${result.forbidden.length})`}
                hint="These belong to a different studio. Switch active location to delete them."
                rows={result.forbidden}
                tone="red"
              />
            )}
            {result.missing?.length > 0 && (
              <Section
                title={`Not found (${result.missing.length})`}
                hint="Probably already deleted. No action needed."
                rows={result.missing.map(id => ({ id, name: id, reason: 'Already gone' }))}
                tone="muted"
              />
            )}
            {/* MAIL-GDPR.1 — these ARE deleted (counted above); what failed is
                a mail statement, so inbox rows still carry their details. */}
            {result.scrub_warnings?.length > 0 && (
              <Section
                title={`Deleted, mail scrub incomplete (${result.scrub_warnings.length})`}
                hint="Gone from the CRM, but some of their mail could not be anonymised and still carries their details. Fix the cause and re-check the inbox by hand; details are in the server log."
                rows={scrubIncompleteRows(result.scrub_warnings)}
                tone="amber"
              />
            )}

            <button
              type="button"
              onClick={closeAndRefresh}
              className="w-full inline-flex items-center justify-center text-sm bg-un1t-text text-un1t-bg font-medium py-2 rounded-md hover:bg-un1t-accent"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClasses = {
    emerald: 'border-emerald-500/40 text-emerald-700',
    muted:   'border-un1t-border text-un1t-subtle',
  }
  return (
    <div className={`border rounded-md p-3 ${toneClasses[tone] || toneClasses.muted}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

function Section({ title, hint, rows, tone }) {
  const toneClasses = {
    amber: 'border-amber-500/30 bg-amber-500/5 text-amber-700',
    red:   'border-red-500/30 bg-red-500/5 text-red-700',
    muted: 'border-un1t-border text-un1t-subtle',
  }
  return (
    <div className={`border rounded-md p-3 ${toneClasses[tone] || toneClasses.muted}`}>
      <div className="text-xs font-semibold mb-1">{title}</div>
      {hint && <div className="text-[11px] opacity-80 mb-2">{hint}</div>}
      <ul className="text-[11px] space-y-0.5 max-h-32 overflow-auto">
        {rows.slice(0, 12).map(r => (
          <li key={r.id}><strong>{r.name}</strong> — {r.reason}</li>
        ))}
        {rows.length > 12 && (
          <li className="opacity-70">…and {rows.length - 12} more</li>
        )}
      </ul>
    </div>
  )
}

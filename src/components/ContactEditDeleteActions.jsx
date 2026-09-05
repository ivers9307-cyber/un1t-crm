'use client'

// Edit + Delete buttons for the contact profile page header.
//
// Edit just navigates to /contacts/[id]/edit (manager+).
// Delete opens a two-step modal:
//   1. Fetch /api/contacts/[id]/impact to show counts of dependent
//      rows split by delete-rule (cascade vs preserved).
//   2. Operator types the contact's first name to confirm. Submit
//      DELETEs the row and routes back to /contacts.
//
// Owner-only for Delete (gated server-side; the button just hides
// for non-owners as a UI hint).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pencil, Trash2, Loader2, AlertTriangle, X } from 'lucide-react'
import { summariseScrubWarnings } from '@/lib/scrub-warnings'

export default function ContactEditDeleteActions({ contact, canEdit, canDelete }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [impact, setImpact] = useState(null)
  const [impactError, setImpactError] = useState(null)
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  // DELBLOCK.1 — the DELETE route now refuses (409) when an FK would block
  // it, and returns the blocking rows. The impact fetch that opened this
  // dialog can be stale by the time the button is clicked (someone else adds
  // a person_group), so this is a second, later answer, not a duplicate of
  // the "Blocking" section above — render it where the operator is looking.
  const [deleteBlockers, setDeleteBlockers] = useState([])
  // MAIL-GDPR.1 — a SUCCESSFUL delete can carry `data.scrub_warnings`: the
  // contact row is gone but a mail statement failed, so inbox rows still hold
  // their details. Shown here, before navigating, because after the push
  // there is no page to show it on. It never blocks: the delete has happened.
  const [scrubSummary, setScrubSummary] = useState(null)

  const expected = (contact.first_name || contact.name?.split(' ')[0] || contact.email || '').trim()

  async function openConfirm() {
    setConfirming(true)
    setImpact(null)
    setImpactError(null)
    setConfirmName('')
    setDeleteError(null)
    setDeleteBlockers([])
    try {
      const r = await fetch(`/api/contacts/${contact.id}/impact`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setImpactError(j.error || `Failed to load impact (${r.status})`)
      } else {
        setImpact(j.data)
      }
    } catch (e) {
      setImpactError(e.message || 'Network error')
    }
  }

  async function doDelete() {
    setDeleting(true)
    setDeleteError(null)
    setDeleteBlockers([])
    try {
      const r = await fetch(`/api/contacts/${contact.id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setDeleteError(j.error || `Delete failed (${r.status})`)
        // DELBLOCK.1 — a 409 carries the rows that blocked it. Nothing was
        // scrubbed or deleted, which is the part worth showing plainly:
        // without this the refusal reads like a failed delete.
        setDeleteBlockers(Array.isArray(j.data?.block_delete) ? j.data.block_delete : [])
        setDeleting(false)
        return
      }
      const summary = summariseScrubWarnings(j.data?.scrub_warnings)
      if (summary) {
        setScrubSummary(summary)
        setDeleting(false)
        return
      }
      leave()
    } catch (e) {
      setDeleteError(e.message || 'Network error')
      setDeleting(false)
    }
  }

  function leave() {
    router.push('/contacts')
    router.refresh()
  }

  // Once the row is gone this page is stale, so every way out of the dialog
  // leaves it; before that, closing just closes.
  function dismiss() {
    if (deleting) return
    if (scrubSummary) leave()
    else setConfirming(false)
  }

  return (
    <>
      {canEdit && (
        <Link
          href={`/contacts/${contact.id}/edit`}
          className="inline-flex items-center gap-1.5 border border-un1t-border text-un1t-subtle text-sm font-medium px-3 py-1.5 rounded-md hover:text-un1t-text hover:border-un1t-muted"
        >
          <Pencil size={14} /> Edit
        </Link>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={openConfirm}
          className="inline-flex items-center gap-1.5 border border-red-500/40 text-red-700 text-sm font-medium px-3 py-1.5 rounded-md hover:bg-red-500/10"
        >
          <Trash2 size={14} /> Delete
        </button>
      )}

      {confirming && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={dismiss}
        >
          <div
            className="bg-un1t-surface border border-un1t-border rounded-xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={22} className="text-red-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="text-base font-semibold text-un1t-text">
                  {scrubSummary ? `${contact.name} deleted` : `Delete ${contact.name}?`}
                </h3>
                {!scrubSummary && <p className="text-xs text-un1t-subtle mt-1">This cannot be undone.</p>}
              </div>
              <button
                type="button"
                onClick={dismiss}
                className="text-un1t-subtle hover:text-un1t-text"
                disabled={deleting}
              >
                <X size={16} />
              </button>
            </div>

            {scrubSummary && (
              <div className="space-y-3">
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 text-xs rounded-md p-3 space-y-1">
                  <p className="font-semibold">The contact was deleted, but the mail scrub was incomplete.</p>
                  <p>
                    {scrubSummary.text}. Those mail rows still carry the person&apos;s details — fix the cause
                    and re-check the inbox by hand. The details are in the server log.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={leave}
                  className="w-full inline-flex items-center justify-center text-sm bg-un1t-text text-un1t-bg font-medium py-2 rounded-md hover:bg-un1t-accent"
                >
                  Continue
                </button>
              </div>
            )}

            {!scrubSummary && impactError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3">
                {impactError}
              </div>
            )}

            {!scrubSummary && !impact && !impactError && (
              <div className="text-xs text-un1t-subtle inline-flex items-center gap-2 mb-3">
                <Loader2 size={12} className="animate-spin" /> Calculating impact…
              </div>
            )}

            {!scrubSummary && impact && (
              <div className="text-sm text-un1t-subtle space-y-3 mb-4">
                {/* IMPACTCAT.1 — a preview that failed to look must not read as
                    a confident zero. Set when the catalog function is
                    unavailable or a count errored. */}
                {impact.partial && (
                  <div className="bg-amber-500/10 text-amber-700 text-xs rounded-md p-2">
                    Some dependent records could not be counted, so this list may be incomplete.
                  </div>
                )}

                {impact.redact_on_delete?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-700 mb-1">Will be redacted</div>
                    <ul className="text-xs space-y-0.5">
                      {impact.redact_on_delete.map(t => (
                        <li key={`${t.table}.${t.column}`}>
                          {t.count} {t.label}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-un1t-muted mt-1">
                      Phone, profile name, message bodies, and media URLs are wiped. Conversation thread + timestamps stay for audit (GDPR right-to-erasure).
                    </p>
                  </div>
                )}

                {impact.block_delete?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-red-700 mb-1">Blocking</div>
                    <ul className="text-xs space-y-0.5">
                      {impact.block_delete.map(t => (
                        <li key={`${t.table}.${t.column}`}>
                          {t.count} {t.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {impact.cascade_on_delete?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Will be deleted</div>
                    <ul className="text-xs space-y-0.5">
                      {impact.cascade_on_delete.map(t => (
                        <li key={`${t.table}.${t.column}`}>
                          {t.count} {t.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {impact.keep_on_delete?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-1">Will stay (unlinked)</div>
                    <ul className="text-xs space-y-0.5">
                      {impact.keep_on_delete.map(t => (
                        <li key={`${t.table}.${t.column}`}>
                          {t.count} {t.label}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-un1t-muted mt-1">
                      These rows preserve revenue / event history but lose the contact link.
                    </p>
                  </div>
                )}

                {/* IMPACTCAT.1 — "Safe to delete" is an assertion, so it needs
                    a complete count behind it. Without the !partial guard a
                    contact with nothing in the 21 legacy tables renders the
                    caution above AND this line, which contradict each other. */}
                {impact.total_rows === 0 && !impact.partial && (
                  <p className="text-xs">No dependent rows. Safe to delete.</p>
                )}
              </div>
            )}

            {!scrubSummary && impact && impact.block_delete?.length === 0 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-un1t-subtle mb-1">
                    Type <strong className="text-un1t-text">{expected}</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    disabled={deleting}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  />
                </div>
                {deleteError && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 space-y-1">
                    <p>{deleteError}</p>
                    {deleteBlockers.length > 0 && (
                      <>
                        <ul className="space-y-0.5">
                          {deleteBlockers.map(t => (
                            <li key={`${t.table}.${t.column}`}>
                              {t.count} {t.label}
                            </li>
                          ))}
                        </ul>
                        <p>Nothing was deleted or redacted.</p>
                      </>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={doDelete}
                  disabled={deleting || confirmName.trim() !== expected}
                  className="w-full inline-flex items-center justify-center gap-2 bg-red-600 text-white text-sm font-medium py-2 rounded-md hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  {deleting ? 'Deleting…' : 'Permanently delete'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

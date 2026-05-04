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

export default function ContactEditDeleteActions({ contact, canEdit, canDelete }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [impact, setImpact] = useState(null)
  const [impactError, setImpactError] = useState(null)
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  const expected = (contact.first_name || contact.name?.split(' ')[0] || contact.email || '').trim()

  async function openConfirm() {
    setConfirming(true)
    setImpact(null)
    setImpactError(null)
    setConfirmName('')
    setDeleteError(null)
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
    try {
      const r = await fetch(`/api/contacts/${contact.id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setDeleteError(j.error || `Delete failed (${r.status})`)
        setDeleting(false)
        return
      }
      router.push('/contacts')
      router.refresh()
    } catch (e) {
      setDeleteError(e.message || 'Network error')
      setDeleting(false)
    }
  }

  return (
    <>
      {canEdit && (
        <Link
          href={`/contacts/${contact.id}/edit`}
          className="inline-flex items-center gap-1.5 border border-un1t-gray text-un1t-light text-sm font-medium px-3 py-1.5 rounded-md hover:text-un1t-white hover:border-un1t-mid"
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
          onClick={() => !deleting && setConfirming(false)}
        >
          <div
            className="bg-un1t-dark border border-un1t-gray rounded-xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={22} className="text-red-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="text-base font-semibold text-un1t-white">Delete {contact.name}?</h3>
                <p className="text-xs text-un1t-light mt-1">This cannot be undone.</p>
              </div>
              <button
                type="button"
                onClick={() => !deleting && setConfirming(false)}
                className="text-un1t-light hover:text-un1t-white"
                disabled={deleting}
              >
                <X size={16} />
              </button>
            </div>

            {impactError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3">
                {impactError}
              </div>
            )}

            {!impact && !impactError && (
              <div className="text-xs text-un1t-light inline-flex items-center gap-2 mb-3">
                <Loader2 size={12} className="animate-spin" /> Calculating impact…
              </div>
            )}

            {impact && (
              <div className="text-sm text-un1t-light space-y-3 mb-4">
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
                    <p className="text-[11px] text-un1t-mid mt-1">
                      WhatsApp history blocks deletion. Merge this contact into another one first.
                    </p>
                  </div>
                )}

                {impact.cascade_on_delete?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-un1t-light mb-1">Will be deleted</div>
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
                    <div className="text-xs uppercase tracking-wider text-un1t-light mb-1">Will stay (unlinked)</div>
                    <ul className="text-xs space-y-0.5">
                      {impact.keep_on_delete.map(t => (
                        <li key={`${t.table}.${t.column}`}>
                          {t.count} {t.label}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-un1t-mid mt-1">
                      These rows preserve revenue / event history but lose the contact link.
                    </p>
                  </div>
                )}

                {impact.total_rows === 0 && (
                  <p className="text-xs">No dependent rows. Safe to delete.</p>
                )}
              </div>
            )}

            {impact && impact.block_delete?.length === 0 && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-un1t-light mb-1">
                    Type <strong className="text-un1t-white">{expected}</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    disabled={deleting}
                    className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                  />
                </div>
                {deleteError && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2">
                    {deleteError}
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

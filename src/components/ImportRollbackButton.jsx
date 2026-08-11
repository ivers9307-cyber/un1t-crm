'use client'

// Rollback button for /contacts/imports/[id]. Master-only (the page
// hides this for non-master). Two-step confirm — type ROLLBACK to
// proceed.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw, Loader2, X, AlertTriangle } from 'lucide-react'

export default function ImportRollbackButton({ importId }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function fire() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/imports/${importId}/rollback`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Rollback failed (${r.status})`)
        return
      }
      setResult(j.data)
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  function close() {
    setOpen(false)
    if (result) router.refresh()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 border border-amber-500/40 text-amber-700 text-xs font-medium px-3 py-1.5 rounded-md hover:bg-amber-500/10"
      >
        <RotateCcw size={12} /> Rollback
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => !busy && close()}>
          <div
            className="bg-un1t-surface border border-un1t-border rounded-xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="text-base font-semibold text-un1t-text">
                  {result ? 'Rollback complete' : 'Roll back this import?'}
                </h3>
                {!result && (
                  <p className="text-xs text-un1t-subtle mt-1">
                    Created contacts will be hard-deleted (with WhatsApp PII redacted). Updated contacts will be restored to their pre-import values where possible.
                  </p>
                )}
              </div>
              <button type="button" onClick={() => !busy && close()} disabled={busy} className="text-un1t-subtle hover:text-un1t-text">
                <X size={16} />
              </button>
            </header>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3">
                {error}
              </div>
            )}

            {!result && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-un1t-subtle mb-1">
                    Type <strong className="text-un1t-text">ROLLBACK</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={busy}
                    className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  />
                </div>
                <button
                  type="button"
                  onClick={fire}
                  disabled={busy || confirm.trim().toUpperCase() !== 'ROLLBACK'}
                  className="w-full inline-flex items-center justify-center gap-2 bg-amber-600 text-white text-sm font-medium py-2 rounded-md hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                  {busy ? 'Rolling back…' : 'Roll back this import'}
                </button>
              </div>
            )}

            {result && (
              <div className="space-y-3">
                <ul className="text-sm text-un1t-subtle space-y-1">
                  <li><strong className="text-un1t-text">{result.deleted}</strong> created contact{result.deleted === 1 ? '' : 's'} deleted</li>
                  <li><strong className="text-un1t-text">{result.restored}</strong> updated contact{result.restored === 1 ? '' : 's'} restored to pre-import values</li>
                  {result.failed > 0 && (
                    <li className="text-amber-700">{result.failed} row{result.failed === 1 ? '' : 's'} could not be reversed (already deleted or modified by hand — see server logs)</li>
                  )}
                  {result.unrestorable_keys > 0 && (
                    // ROLLBACK-ALLOW.1 — expected to be 0 forever. A non-zero
                    // count means a snapshot carried a column rollback is not
                    // allowed to write back, i.e. a writer and the allowlist
                    // have drifted. Worth an operator seeing, not just a log line.
                    <li className="text-amber-700">
                      {result.unrestorable_keys} snapshot field{result.unrestorable_keys === 1 ? '' : 's'} could not be restored (outside the import field set — see server logs)
                    </li>
                  )}
                </ul>
                <button
                  type="button"
                  onClick={close}
                  className="w-full inline-flex items-center justify-center text-sm bg-un1t-text text-un1t-bg font-medium py-2 rounded-md hover:bg-un1t-accent"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

'use client'

// ContactMergeModal — two-step merge UI.
//
// Step 1: pick which of the two contacts is the survivor. Side-by-
//         side preview shows what each contact has so the operator
//         can choose intelligently. Clicking "Make survivor" on
//         either side flips the choice.
// Step 2: confirm. Shows the merged-fields preview (survivor wins,
//         loser fills empty) + a count of dependent rows that will
//         fold across. Operator types the loser's name to confirm.
//
// Owner-only behaviour gated server-side. The button that opens
// this modal is also gated, so non-owners shouldn't reach this UI.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitMerge, X, Loader2, AlertTriangle, ArrowRight } from 'lucide-react'

const isEmpty = (v) =>
  v === null || v === undefined || v === '' ||
  (typeof v === 'string' && v.trim() === '')

// Mirrors src/lib/contact-merge.js#pickMergedFields. Duplicated for
// the preview UI so the modal doesn't need to round-trip the API
// before showing what the merge will look like.
function previewMergedFields(survivor, loser) {
  const out = {}
  for (const f of ['name', 'email', 'phone', 'pipeline_stage_slug', 'lead_source', 'label', 'glofox_member_id']) {
    out[f] = isEmpty(survivor[f]) && !isEmpty(loser[f]) ? loser[f] : survivor[f]
  }
  return out
}

export default function ContactMergeModal({ contactIds, contacts, onClose }) {
  const router = useRouter()
  const [survivorId, setSurvivorId] = useState(contactIds[0])
  const [confirmName, setConfirmName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [stage, setStage] = useState('pick') // 'pick' | 'confirm'

  // Impact counts for the loser (what will fold across). Lazy-load
  // when the operator hits "Continue".
  const [impact, setImpact] = useState(null)
  const [impactErr, setImpactErr] = useState(null)
  const [loadingImpact, setLoadingImpact] = useState(false)

  const survivor = contacts.find(c => c.id === survivorId)
  const loser = contacts.find(c => c.id !== survivorId)
  const merged = survivor && loser ? previewMergedFields(survivor, loser) : null
  const expected = (loser?.first_name || loser?.name?.split(' ')[0] || loser?.email || '').trim()

  useEffect(() => {
    if (stage !== 'confirm' || !loser) return
    let cancelled = false
    async function load() {
      setLoadingImpact(true)
      setImpactErr(null)
      try {
        const r = await fetch(`/api/contacts/${loser.id}/impact`, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!r.ok || j.success === false) {
          setImpactErr(j.error || `Failed to load impact (${r.status})`)
        } else {
          setImpact(j.data)
        }
      } catch (e) {
        if (!cancelled) setImpactErr(e.message || 'Network error')
      } finally {
        if (!cancelled) setLoadingImpact(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, loser?.id])

  async function doMerge() {
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch('/api/contacts/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ survivor_id: survivorId, loser_id: loser.id }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Merge failed (${r.status})`)
        setSubmitting(false)
        return
      }
      // Success — bounce to the survivor's profile so the operator
      // can verify the result.
      router.push(`/contacts/${survivorId}`)
      router.refresh()
    } catch (e) {
      setError(e.message || 'Network error')
      setSubmitting(false)
    }
  }

  if (!survivor || !loser) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-un1t-surface border border-un1t-border rounded-xl max-w-2xl w-full max-h-[85vh] overflow-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <GitMerge size={20} className="text-un1t-subtle mt-0.5 shrink-0" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-un1t-text">Merge contacts</h3>
            <p className="text-xs text-un1t-subtle mt-0.5">
              Pick which contact survives. The other will be deleted and its history folds across.
            </p>
          </div>
          <button type="button" onClick={() => !submitting && onClose()} disabled={submitting} className="text-un1t-subtle hover:text-un1t-text">
            <X size={16} />
          </button>
        </div>

        {stage === 'pick' && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {contactIds.map((id) => {
                const c = contacts.find(x => x.id === id)
                if (!c) return null
                const chosen = id === survivorId
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSurvivorId(id)}
                    className={`text-left rounded-lg p-3 border transition-colors ${
                      chosen
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-un1t-border hover:border-un1t-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-un1t-text">{c.name || c.email || '(no name)'}</span>
                      {chosen && (
                        <span className="text-[10px] uppercase tracking-wider text-emerald-700 font-bold">Survivor</span>
                      )}
                    </div>
                    <ul className="text-xs text-un1t-subtle space-y-0.5">
                      <li>{c.email || <span className="text-un1t-muted">no email</span>}</li>
                      <li>{c.phone || <span className="text-un1t-muted">no phone</span>}</li>
                      <li>Stage: {c.pipeline_stage_slug || <span className="text-un1t-muted">none</span>}</li>
                      <li>Source: {c.lead_source || <span className="text-un1t-muted">none</span>}</li>
                      <li>Created: {c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</li>
                    </ul>
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => setStage('confirm')}
              className="w-full inline-flex items-center justify-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium py-2 rounded-md hover:bg-un1t-accent"
            >
              Continue <ArrowRight size={14} />
            </button>
          </>
        )}

        {stage === 'confirm' && (
          <>
            <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 mb-3">
              <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">After merge</div>
              <ul className="text-xs text-un1t-text space-y-1">
                <li><span className="text-un1t-subtle">Name:</span> {merged.name || '—'}</li>
                <li><span className="text-un1t-subtle">Email:</span> {merged.email || '—'}</li>
                <li><span className="text-un1t-subtle">Phone:</span> {merged.phone || '—'}</li>
                <li><span className="text-un1t-subtle">Stage:</span> {merged.pipeline_stage_slug || '—'}</li>
                <li><span className="text-un1t-subtle">Source:</span> {merged.lead_source || '—'}</li>
              </ul>
              <p className="text-[11px] text-un1t-muted mt-2">
                Tags from both contacts will union. Any field that&apos;s empty on the survivor is filled from the loser.
              </p>
            </div>

            {loadingImpact && (
              <div className="text-xs text-un1t-subtle inline-flex items-center gap-2 mb-3">
                <Loader2 size={12} className="animate-spin" /> Calculating what folds across…
              </div>
            )}
            {impactErr && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2 mb-3">
                {impactErr}
              </div>
            )}
            {impact && (impact.cascade_on_delete?.length > 0 || impact.keep_on_delete?.length > 0 || impact.block_delete?.length > 0 || impact.redact_on_delete?.length > 0) && (
              <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 mb-3">
                <div className="text-xs uppercase tracking-wider text-un1t-subtle mb-2">Folding across from <strong className="text-un1t-text">{loser.name || loser.email}</strong></div>
                <ul className="text-xs text-un1t-subtle space-y-0.5">
                  {[...(impact.block_delete || []), ...(impact.cascade_on_delete || []), ...(impact.redact_on_delete || []), ...(impact.keep_on_delete || [])].map(t => (
                    <li key={`${t.table}.${t.column}`}>{t.count} {t.label}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 mb-3 flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-700">
                <strong>{loser.name || loser.email}</strong> will be deleted after the merge. This is irreversible.
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-un1t-subtle mb-1">
                  Type <strong className="text-un1t-text">{expected}</strong> to confirm:
                </label>
                <input
                  type="text"
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
              </div>
              {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md p-2">
                  {error}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStage('pick')}
                  disabled={submitting}
                  className="flex-1 inline-flex items-center justify-center text-sm border border-un1t-border text-un1t-subtle py-2 rounded-md hover:text-un1t-text hover:border-un1t-muted"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={doMerge}
                  disabled={submitting || confirmName.trim() !== expected}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-red-600 text-white text-sm font-medium py-2 rounded-md hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />}
                  {submitting ? 'Merging…' : 'Merge'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

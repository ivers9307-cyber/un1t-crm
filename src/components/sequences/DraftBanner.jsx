'use client'

// The unpublished-draft banner above the flow editor. Two states:
//   - draft masking a PUBLISHED graph → "production differs" + Discard draft
//     (DELETE the draft, refresh → the editor reopens what's actually live).
//     Without this a stale draft permanently masks the production automation.
//   - draft on a never-published sequence → plain draft label; there is no
//     production version to discard back to.
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function DraftBanner({ sequenceId, isDraft, isPublished, writeSteps = [] }) {
  const router = useRouter()
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState(null)

  if (!isDraft) return null

  async function discard() {
    if (!window.confirm('Discard this draft? The editor will reopen the published version — your unpublished changes are gone for good.')) return
    setDiscarding(true)
    setError(null)
    try {
      const res = await fetch(`/api/sequences/${sequenceId}/graph`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to discard draft')
      router.refresh() // re-resolve server-side: draft gone → published graph opens
    } catch (e) {
      setError(e.message)
      setDiscarding(false)
    }
  }

  return (
    <div className="max-w-md mx-auto mb-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-700">
      {isPublished ? (
        <div className="flex items-start justify-between gap-3">
          <p className="font-semibold">Viewing draft — production differs. The live automation still runs the published version until you Publish.</p>
          <button
            type="button"
            onClick={discard}
            disabled={discarding}
            className="shrink-0 px-2 py-1 rounded-md border border-amber-500/40 font-semibold hover:bg-amber-500/10 disabled:opacity-50"
          >
            {discarding ? 'Discarding…' : 'Discard draft'}
          </button>
        </div>
      ) : (
        <p className="font-semibold">Unpublished draft — review, then Publish to make it live.</p>
      )}
      {writeSteps.length > 0 && (
        <p className="mt-1">Heads up: this draft will also {writeSteps.join(', ')}. Double-check those steps are right.</p>
      )}
      {error && <p className="mt-1 text-rose-700">{error}</p>}
    </div>
  )
}

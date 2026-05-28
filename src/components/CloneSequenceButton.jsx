'use client'

// CloneSequenceButton — small icon button on each sequence row
// in /communications/sequences. Posts to /api/sequences/[id]/clone
// and routes the operator into the freshly-created draft so they
// can rename and tweak. Pairs with the Flow templates gallery:
// templates seed new sequences from canned recipes; this clones
// the operator's already-customised sequences for dup-and-tweak.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Loader2 } from 'lucide-react'

export default function CloneSequenceButton({ sequenceId, sequenceName }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function clone(e) {
    // Stop propagation so the surrounding row's Link doesn't also
    // fire and navigate the operator into the SOURCE editor while
    // the clone is in flight.
    e?.stopPropagation?.()
    e?.preventDefault?.()
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/sequences/${sequenceId}/clone`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Clone failed (${r.status})`)
      router.push(`/email/sequences/${j.data.sequence_id}`)
    } catch (err) {
      setError(err.message || 'Clone failed')
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={clone}
      disabled={busy}
      title={error || `Clone "${sequenceName}"`}
      aria-label={`Clone ${sequenceName}`}
      className={`p-1.5 rounded transition-colors ${
        error
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-un1t-subtle hover:text-un1t-text hover:bg-un1t-border/40'
      } disabled:opacity-50`}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
    </button>
  )
}

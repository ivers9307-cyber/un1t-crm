'use client'

// Delete a sequence from the list. Calls DELETE /api/sequences/[id] (which
// removes its steps then the row), confirms first, and refreshes the list.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'

export default function DeleteSequenceButton({ sequenceId, sequenceName }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const onDelete = async () => {
    if (!window.confirm(`Delete “${sequenceName || 'this sequence'}”? This can’t be undone.`)) return
    setBusy(true)
    try {
      const r = await fetch(`/api/sequences/${sequenceId}`, { method: 'DELETE' })
      const j = await r.json()
      if (j.success) { router.refresh() } else { setBusy(false); window.alert(j.error || 'Could not delete the sequence.') }
    } catch { setBusy(false); window.alert('Network error deleting the sequence.') }
  }

  return (
    <button type="button" onClick={onDelete} disabled={busy} title="Delete sequence" aria-label="Delete sequence"
      className="flex items-center justify-center w-7 h-7 rounded-md text-un1t-subtle hover:text-rose-700 hover:bg-rose-500/10 transition-colors disabled:opacity-40">
      <Trash2 size={14} />
    </button>
  )
}

'use client'

// FLOW-GRAPH Phase 2 (PR3c-3) — "New sequence" creates a blank draft via
// POST /api/sequences (location derives from the session) and opens it in the
// new visual builder, replacing the old link to /email/sequences/new (classic).
// Creating on an explicit click (not on GET navigation) avoids littering
// orphan drafts.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

export default function NewSequenceButton({ className, label = 'New automation' }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/sequences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled Sequence' }),
      })
      const j = await r.json()
      if (j.success && j.sequence?.id) {
        router.push(`/automations/${j.sequence.id}`)
      } else {
        setBusy(false)
        window.alert(j.error || 'Could not create the automation.')
      }
    } catch {
      setBusy(false)
      window.alert('Network error creating the automation.')
    }
  }

  return (
    <button type="button" onClick={create} disabled={busy} className={className}>
      <Plus size={16} /> {busy ? 'Creating…' : label}
    </button>
  )
}

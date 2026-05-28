'use client'

// UI-FOUND.3 — migrated onto the shared <Button> primitive
// (variant="ghost" size="icon"). Behaviour unchanged: confirm →
// DELETE → refresh; the destructive red-on-hover is preserved via
// className.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'

export default function DeleteTemplateButton({ templateId }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!confirm('Delete this template? This cannot be undone.')) return
    setDeleting(true)
    try {
      await fetch(`/api/templates/${templateId}`, { method: 'DELETE' })
      router.refresh()
    } catch {
      alert('Failed to delete template')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      icon={Trash2}
      loading={deleting}
      onClick={handleDelete}
      title="Delete template"
      className="text-un1t-muted hover:text-red-400"
    />
  )
}

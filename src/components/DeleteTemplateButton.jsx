'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'

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
    <button
      onClick={handleDelete}
      disabled={deleting}
      className="p-1.5 text-un1t-mid hover:text-red-400 transition-colors rounded disabled:opacity-50"
      title="Delete template"
    >
      <Trash2 size={14} />
    </button>
  )
}

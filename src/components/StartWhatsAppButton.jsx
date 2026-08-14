'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle } from 'lucide-react'

export default function StartWhatsAppButton({ contactId, contactPhone, waPhone }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const phone = waPhone || contactPhone

  if (!phone) return null

  async function handleClick() {
    setLoading(true)
    try {
      const res = await fetch('/api/whatsapp/conversations/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      })
      const data = await res.json()

      if (data.success && data.conversation_id) {
        router.push(`/communications/inbox?c=${data.conversation_id}`)
      } else {
        alert(data.error || 'Failed to start conversation')
      }
    } catch {
      alert('Failed to start conversation')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="flex items-center gap-1.5 text-sm bg-green-600 text-white px-3 py-1.5 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
    >
      <MessageCircle size={14} />
      {loading ? 'Opening...' : 'WhatsApp'}
    </button>
  )
}

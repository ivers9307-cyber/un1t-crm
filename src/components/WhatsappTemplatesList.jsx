// src/components/WhatsappTemplatesList.jsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { createBrowserClient } from '@/lib/supabase'

const STATUS_COLOR = {
  APPROVED: 'text-green-600',
  REJECTED: 'text-red-600',
  PAUSED: 'text-amber-600',
  DISABLED: 'text-red-600',
  PENDING: 'text-un1t-muted',
}
const QUALITY_CHIP = {
  GREEN: 'bg-green-500/15 text-green-700',
  YELLOW: 'bg-amber-500/15 text-amber-700',
  RED: 'bg-red-500/15 text-red-700',
}
const MANAGER_URL = 'https://business.facebook.com/wa/manage/message-templates/'

export default function WhatsappTemplatesList({ locationId }) {
  const [templates, setTemplates] = useState([])
  const [deletingId, setDeletingId] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  const fetchTemplates = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch { /* best-effort */ }
  }, [locationId])

  async function handleDelete(t) {
    if (!confirm(`Delete "${t.name}"? It will also be removed from your Meta account, and any automation still sending it will fail. This cannot be undone.`)) return
    setDeletingId(t.id)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/whatsapp/templates/${t.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Delete failed')
      setTemplates(prev => prev.filter(x => x.id !== t.id))
    } catch (err) {
      setDeleteError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  // Live-update on any template change at this location (mirrors WAInbox).
  useEffect(() => {
    if (!locationId) return
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`wa-templates-${locationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_templates' }, () => fetchTemplates())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [locationId, fetchTemplates])

  if (templates.length === 0) {
    return <p className="text-sm text-un1t-subtle px-1 py-4">No WhatsApp templates yet.</p>
  }

  return (
    <div className="divide-y divide-un1t-border">
      {deleteError && (
        <p className="text-xs text-red-700 px-1 py-2">{deleteError}</p>
      )}
      {templates.map(t => (
        <div key={t.id} className="flex items-center justify-between py-3 px-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/whatsapp/templates/${t.id}`} className="text-sm font-medium text-un1t-text hover:underline truncate">{t.name}</Link>
              {t.quality_rating && QUALITY_CHIP[t.quality_rating] && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${QUALITY_CHIP[t.quality_rating]}`}>{t.quality_rating}</span>
              )}
            </div>
            <p className="text-xs text-un1t-subtle truncate">
              {t.category} · {t.language} · <span className={STATUS_COLOR[t.status] || 'text-un1t-muted'}>{t.status}</span>
              {t.status === 'REJECTED' && t.rejection_reason ? ` — ${t.rejection_reason}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {['REJECTED', 'PAUSED'].includes(t.status) && (
              <>
                <Link href={`/whatsapp/templates/${t.id}`} className="text-xs text-blue-600 hover:underline">Edit &amp; resubmit</Link>
                <a href={MANAGER_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-un1t-subtle hover:underline">Appeal ↗</a>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              icon={Trash2}
              loading={deletingId === t.id}
              onClick={() => handleDelete(t)}
              title="Delete template"
              className="text-un1t-muted hover:text-red-400"
            />
          </div>
        </div>
      ))}
    </div>
  )
}

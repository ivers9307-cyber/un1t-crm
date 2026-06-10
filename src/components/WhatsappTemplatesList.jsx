// src/components/WhatsappTemplatesList.jsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
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

  const fetchTemplates = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch { /* best-effort */ }
  }, [locationId])

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
          {['REJECTED', 'PAUSED'].includes(t.status) && (
            <div className="flex items-center gap-2 shrink-0">
              <Link href={`/whatsapp/templates/${t.id}`} className="text-xs text-blue-600 hover:underline">Edit &amp; resubmit</Link>
              <a href={MANAGER_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-un1t-subtle hover:underline">Appeal ↗</a>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

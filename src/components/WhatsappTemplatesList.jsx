// src/components/WhatsappTemplatesList.jsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Trash2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'
import { createBrowserClient } from '@/lib/supabase'
import { groupWaTemplates, listWaTemplateGroups, UNGROUPED_LABEL } from '@shared/wa-template-groups'

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
  // WA-TPL-GROUPS — per-row inline group edits (mig 450). Draft values keyed
  // by template id; saved on blur/Enter so a batch of templates can be
  // organised without opening each editor page.
  const [groupDrafts, setGroupDrafts] = useState({})
  // These rows are a CACHE of Meta's templates, and nothing refreshes them on its
  // own — so what is on screen can be months behind what Meta will actually send.
  // "Refresh from Meta" is the only trigger, and syncError is the only way a failed
  // refresh is distinguishable from a clean one.
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)

  const fetchTemplates = useCallback(async () => {
    if (!locationId) return
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}`)
      const data = await res.json()
      if (data.success) setTemplates(data.templates || [])
    } catch { /* best-effort */ }
  }, [locationId])

  // Deliberately NOT folded into fetchTemplates: that one also runs on every
  // realtime template change, and syncing on each would hammer Meta's API.
  async function refreshFromMeta() {
    if (!locationId || syncing) return
    setSyncing(true)
    setSyncError(null)
    try {
      const res = await fetch(`/api/whatsapp/templates?location_id=${locationId}&sync=true`)
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Refresh failed')
      setTemplates(data.templates || [])
      // null means the refresh genuinely landed; a string means these rows are stale.
      setSyncError(data.sync_error || null)
    } catch (err) {
      setSyncError(err.message || 'Could not refresh templates from Meta.')
    } finally {
      setSyncing(false)
    }
  }

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

  async function saveGroup(template) {
    const draft = groupDrafts[template.id]
    if (draft === undefined) return
    const next = draft.trim()
    if (next === (template.display_group || '')) return
    try {
      await fetch(`/api/whatsapp/templates/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_group: next || null }),
      })
      await fetchTemplates()
      // Drop the draft so the row reflects the saved value (or reverts
      // visibly if the save didn't stick).
      setGroupDrafts(d => { const rest = { ...d }; delete rest[template.id]; return rest })
    } catch { /* best-effort — the realtime refresh will reconcile */ }
  }

  const header = (
    <div className="flex items-center justify-between gap-3 px-1 pb-1">
      <p className="text-xs text-un1t-subtle">Cached from Meta — refresh to pick up edits made in WhatsApp Manager.</p>
      <Button variant="secondary" size="sm" icon={RefreshCw} loading={syncing} onClick={refreshFromMeta} disabled={!locationId}>
        Refresh from Meta
      </Button>
    </div>
  )

  // Rendered in BOTH the empty and populated states: a refresh that failed matters
  // most when the list looks wrong or empty, which is exactly when the old code
  // returned early and showed nothing at all.
  const syncBanner = syncError ? (
    <p className="text-xs text-amber-700 px-1 py-2" role="status">Showing cached templates — {syncError}</p>
  ) : null

  if (templates.length === 0) {
    return (
      <div>
        {header}
        {syncBanner}
        <p className="text-sm text-un1t-subtle px-1 py-4">No WhatsApp templates yet.</p>
      </div>
    )
  }

  const groups = groupWaTemplates(templates)
  const groupSuggestions = listWaTemplateGroups(templates)

  return (
    <div>
      {header}
      {syncBanner}
      <datalist id="wa-template-group-options">
        {groupSuggestions.map(g => <option key={g} value={g} />)}
      </datalist>
      {deleteError && (
        <p className="text-xs text-red-700 px-1 py-2">{deleteError}</p>
      )}
      {groups.map(group => (
        <div key={group.label} className="mb-2">
          {/* A lone Ungrouped bucket (nobody has set groups yet) needs no header. */}
          {!(groups.length === 1 && group.label === UNGROUPED_LABEL) && (
            <p className="text-[10px] text-un1t-muted font-semibold uppercase tracking-wider px-1 pt-2 pb-1">{group.label}</p>
          )}
          <div className="divide-y divide-un1t-border">
            {group.templates.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-3 py-3 px-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link href={`/communications/templates/whatsapp/${t.id}`} className="text-sm font-medium text-un1t-text hover:underline truncate">{t.name}</Link>
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
                  <input
                    type="text"
                    list="wa-template-group-options"
                    value={groupDrafts[t.id] ?? t.display_group ?? ''}
                    onChange={e => setGroupDrafts(d => ({ ...d, [t.id]: e.target.value }))}
                    onBlur={() => saveGroup(t)}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                    placeholder="Group…"
                    title="Picker group — templates with the same group appear together in the inbox template picker"
                    className="w-28 bg-un1t-bg border border-un1t-border rounded-md px-2 py-1 text-xs text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
                  />
                  {['REJECTED', 'PAUSED'].includes(t.status) && (
                    <>
                      <Link href={`/communications/templates/whatsapp/${t.id}`} className="text-xs text-blue-600 hover:underline">Edit &amp; resubmit</Link>
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
                    // COMMSLAYOUT.5 — light surface: the destructive hover needs
                    // the -700 ramp, same as every other red on this page.
                    className="text-un1t-muted hover:text-red-700"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

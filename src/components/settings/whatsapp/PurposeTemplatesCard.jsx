'use client'

// WAORGNUMBER.2 (R5) — "Templates used for automatic messages". One picker per
// fixed-purpose WhatsApp message (class booking confirmation, consultation
// confirmation, event waitlist offer, ad-lead welcome), listing THIS studio's
// APPROVED templates of a category the message may use. A pick is saved at once
// (PUT /api/locations/[id]/whatsapp/purpose-templates); "Default" clears it, so
// the sender goes back to its old template name at the studio. A studio with no
// pick and no template of the default name sends nothing for that message.
//
//   GET  /api/locations/[id]/whatsapp/purpose-templates   { selected, can_edit }
//   GET  /api/whatsapp/templates?location_id=…            the studio's templates
//
// Nothing is shown over a read that failed (CHANNELREAD.1): a picker that
// claimed "Default" while the real pick is unknown would invite a wrong save.

import { useEffect, useState } from 'react'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { PURPOSES, PURPOSE_KEYS, PURPOSE_LABELS } from '@/lib/whatsapp-purpose-templates'

export default function PurposeTemplatesCard({ locationId, canEdit: canEditProp = true }) {
  const [state, setState] = useState('loading') // loading | ready | failed
  const [templates, setTemplates] = useState([])
  const [selected, setSelected] = useState({})
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(null)
  const [savedPurpose, setSavedPurpose] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setState('loading')
      try {
        const [pickRes, tplRes] = await Promise.all([
          fetch(`/api/locations/${locationId}/whatsapp/purpose-templates`),
          fetch(`/api/whatsapp/templates?location_id=${encodeURIComponent(locationId)}`),
        ])
        const pick = await pickRes.json()
        const tpl = await tplRes.json()
        if (cancelled) return
        if (!pickRes.ok || !pick.success || !pick.data?.selected || !tplRes.ok || !tpl.success || !Array.isArray(tpl.templates)) {
          setState('failed')
          return
        }
        setSelected(pick.data.selected)
        setCanEdit(pick.data.can_edit === true)
        setTemplates(tpl.templates)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  async function choose(purpose, value) {
    setBusy(purpose); setError(null); setSavedPurpose(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/whatsapp/purpose-templates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, templateId: value || null }),
      })
      const j = await res.json()
      if (!res.ok || !j.success || !j.data?.selected) throw new Error(j.error || 'Could not save that choice')
      setSelected(j.data.selected)
      setSavedPurpose(purpose)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const editable = canEdit && canEditProp

  return (
    <div className="bg-un1t-bg border border-un1t-border rounded-md p-3 space-y-2">
      <div>
        <h4 className="text-sm font-semibold text-un1t-text mb-1">Templates used for automatic messages</h4>
        <p className="text-xs text-un1t-subtle">
          Pick which of this studio&apos;s approved templates each automatic message uses. With
          &quot;Default&quot; the message uses the template with its usual name at this studio, and if
          there isn&apos;t one it isn&apos;t sent.
        </p>
      </div>

      {state === 'loading' && (
        <div className="text-xs text-un1t-subtle inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}
      {state === 'failed' && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> Could not load these settings just now. Reload the page to try again.
        </div>
      )}

      {state === 'ready' && PURPOSE_KEYS.map((purpose) => {
        const def = PURPOSES[purpose]
        const copy = PURPOSE_LABELS[purpose]
        const choices = templates.filter((t) => t.status === 'APPROVED' && def.categories.includes(String(t.category || '').toUpperCase()))
        const current = selected[purpose] || ''
        const stale = current && !choices.some((t) => t.id === current)
        const hasDefault = templates.some((t) => t.name === def.fallbackName && t.status === 'APPROVED')
        const selectId = `wa-purpose-${purpose}`
        return (
          <div key={purpose} className="space-y-0.5">
            <label htmlFor={selectId} className="block text-[10px] uppercase tracking-wider text-un1t-subtle">{copy.label}</label>
            <div className="flex items-center gap-2">
              <select
                id={selectId}
                disabled={!editable || busy === purpose}
                className="min-w-0 flex-1 bg-un1t-surface border border-un1t-border rounded px-2 py-1 text-[11px] text-un1t-text disabled:opacity-60"
                value={current}
                onChange={(e) => choose(purpose, e.target.value)}
              >
                <option value="">
                  {hasDefault ? `Default (${def.fallbackName})` : `Default (no “${def.fallbackName}” template here: not sent)`}
                </option>
                {stale && <option value={current}>Chosen template (not approved any more)</option>}
                {choices.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.language ? ` (${t.language})` : ''}</option>
                ))}
              </select>
              {busy === purpose && <Loader2 size={12} className="animate-spin text-un1t-subtle" />}
              {savedPurpose === purpose && (
                <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1 whitespace-nowrap">
                  <CheckCircle2 size={11} /> Saved
                </span>
              )}
            </div>
            <div className="text-[10px] text-un1t-muted">{copy.hint}</div>
          </div>
        )
      })}

      {error && (
        <div className="text-xs text-red-700 inline-flex items-center gap-1.5">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {state === 'ready' && !editable && (
        <p className="text-[11px] text-un1t-subtle">An owner or manager can change these.</p>
      )}
    </div>
  )
}

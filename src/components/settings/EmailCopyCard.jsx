'use client'

// K7 — per-location email copy card.
//
// Settings -> Locations -> <name> -> Details, alongside send quiet hours.
// Two strings a RECIPIENT reads, backed by company_settings (mig 530):
//   • the "view in browser" link at the top of every broadcast (WEBVIEW.1),
//   • the note at the foot of the hosted web copy explaining why there is no
//     personal unsubscribe link on it.
//
// They were hard-coded constants, against the standing rule that
// customer-facing copy is operator-editable with a default fallback. Clearing
// a box restores the default rather than shipping an empty label.
//
// Reads + writes via /api/locations/[id]/email-copy.

import { useEffect, useState } from 'react'
import { Mail, Loader2, Check, AlertTriangle, RotateCcw } from 'lucide-react'

const LABEL_MAX = 120
const NOTE_MAX = 400

export default function EmailCopyCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [defaults, setDefaults] = useState({ label: '', note: '' })
  const [saved, setSaved] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/email-copy`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          setLabel(j.data.view_in_browser_label)
          setNote(j.data.hosted_copy_note)
          setDefaults({ label: j.data.default_view_in_browser_label, note: j.data.default_hosted_copy_note })
          setSaved({ label: j.data.view_in_browser_label, note: j.data.hosted_copy_note })
          setCanEdit(!!j.data.can_edit)
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [locationId])

  const dirty = !saved || label !== saved.label || note !== saved.note
  const tooLong = label.trim().length > LABEL_MAX || note.trim().length > NOTE_MAX
  const isDefault = label.trim() === defaults.label && note.trim() === defaults.note

  async function save() {
    if (saving || tooLong) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/email-copy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view_in_browser_label: label, hosted_copy_note: note }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        setLabel(j.data.view_in_browser_label)
        setNote(j.data.hosted_copy_note)
        setSaved({ label: j.data.view_in_browser_label, note: j.data.hosted_copy_note })
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4 text-sm text-un1t-subtle inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading email copy…
      </div>
    )
  }

  const field = 'w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1.5 text-xs text-un1t-text disabled:opacity-60'

  return (
    <section className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="inline-flex items-center gap-2">
        <Mail size={14} className="text-un1t-subtle" />
        <h4 className="text-sm font-semibold text-un1t-text">Email copy</h4>
      </div>
      <p className="text-xs text-un1t-subtle mt-1 max-w-md">
        Wording your recipients read on every broadcast. Leave a box empty to
        go back to the default.
      </p>

      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="view-in-browser-label" className="block text-xs text-un1t-text mb-1">
            &ldquo;View in browser&rdquo; link
          </label>
          <input
            id="view-in-browser-label"
            type="text"
            value={label}
            maxLength={LABEL_MAX}
            disabled={!canEdit}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={defaults.label}
            className={field}
          />
          <p className="mt-1 text-xs text-un1t-muted">
            Sits at the top of every broadcast. Gmail cuts off a long email, and
            this is how a recipient reads the rest of it.
          </p>
        </div>

        <div>
          <label htmlFor="hosted-copy-note" className="block text-xs text-un1t-text mb-1">
            Note on the web copy
          </label>
          <textarea
            id="hosted-copy-note"
            rows={3}
            value={note}
            maxLength={NOTE_MAX}
            disabled={!canEdit}
            onChange={(e) => setNote(e.target.value)}
            placeholder={defaults.note}
            className={`${field} resize-y`}
          />
          <p className="mt-1 text-xs text-un1t-muted">
            Shown at the foot of the web copy, which carries no personal
            unsubscribe link because the page can be forwarded to anyone.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-2 text-xs text-red-700 bg-red-500/10 border border-red-200 rounded p-2 inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || tooLong || saving}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
          </button>
          <button
            type="button"
            onClick={() => { setLabel(defaults.label); setNote(defaults.note) }}
            disabled={isDefault}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-un1t-border text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
          >
            <RotateCcw size={12} /> Reset to default
          </button>
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-xs text-green-700">
              <Check size={12} /> Saved
            </span>
          )}
        </div>
      )}
    </section>
  )
}

'use client'

// Signup-page copy editor (HOST-GROWTH.B). Collapsible panel under the
// "Your signup page" card: four capped text fields, per-field default
// placeholders, save via PATCH /api/host/list-page. Empty field = use the
// default (stored as NULL).

import { useState } from 'react'

const FIELDS = [
  { key: 'list_headline', label: 'Headline', max: 120, multiline: false, placeholder: 'Default: your host name' },
  { key: 'list_blurb', label: 'Intro text', max: 500, multiline: true, placeholder: 'Default: "Get emails about your events. Unsubscribe anytime."' },
  { key: 'list_button_label', label: 'Button label', max: 40, multiline: false, placeholder: 'Default: "Join the list"' },
  { key: 'list_success_message', label: 'Success message', max: 500, multiline: true, placeholder: "Default: \"We'll email you about upcoming events…\"" },
]

const INPUT = 'w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/40'

export default function HostListPageEditor({ initial, previewUrl, onClose, onSaved }) {
  const [values, setValues] = useState(() => {
    const v = {}
    for (const f of FIELDS) v[f.key] = initial?.[f.key] || ''
    return v
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/host/list-page', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not save — try again.')
      // The PATCH returns the patch actually written (trimmed, nulls for
      // cleared fields) — merge it over the submitted values so state
      // reflects the server's canonical copy, not the raw client input.
      const canonical = { ...values }
      if (j.data) for (const k of Object.keys(j.data)) canonical[k] = j.data[k] ?? ''
      onSaved(canonical)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`lp-${f.key}`} className="block text-xs text-white/50 mb-1">
            {f.label} <span className="text-white/30">({(values[f.key] || '').length}/{f.max})</span>
          </label>
          {f.multiline ? (
            <textarea id={`lp-${f.key}`} rows={3} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          ) : (
            <input id={`lp-${f.key}`} maxLength={f.max} value={values[f.key]} placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={INPUT} />
          )}
        </div>
      ))}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={saving}
          className="rounded-lg bg-white text-black text-xs font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose} className="text-xs text-white/50 hover:text-white px-2 py-2">Cancel</button>
        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-white/40 hover:text-white">
          Preview →
        </a>
      </div>
    </div>
  )
}

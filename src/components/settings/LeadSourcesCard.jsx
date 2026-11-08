'use client'

// WAYSIN.5 — the studio's own lead sources (Settings → Locations → <name> →
// Details, beside ProgrammeBoardRulesCard). The nine defaults and every value
// already on a contact at the studio are offered anyway; this list adds the
// ones the studio wants to pick before any contact carries them. Reads and
// writes /api/locations/[id]/lead-sources (owner or master writes).

import { useEffect, useState } from 'react'
import { Tags, Loader2, Check, AlertTriangle } from 'lucide-react'

const MAX = 50
const PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
const toText = (list) => (Array.isArray(list) ? list.join('\n') : '')
const toList = (text) => [...new Set(String(text || '').split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean))]

export default function LeadSourcesCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [others, setOthers] = useState([])
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/locations/${locationId}/lead-sources`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j?.success) { setError(j?.error || 'Could not load the lead sources'); return }
        const t = toText(j.data.studio_sources)
        setCanEdit(Boolean(j.data.can_edit))
        setText(t); setSaved(t)
        setOthers((j.data.sources || []).filter((s) => s.origin !== 'studio'))
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not load the lead sources') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const list = toList(text)
  const bad = list.filter((v) => !PATTERN.test(v))
  const tooMany = list.length > MAX
  const dirty = text !== saved

  async function save() {
    if (bad.length || tooMany) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/lead-sources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: list }),
      })
      const j = await res.json()
      if (!j?.success) { setError(j?.error || 'Could not save'); return }
      const t = toText(j.data.studio_sources)
      setText(t); setSaved(t)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch (e) {
      setError(e?.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-xl p-5">
      <div className="flex items-start gap-3">
        <Tags className="w-5 h-5 text-un1t-subtle mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-un1t-text">Lead sources</h3>
          <p className="text-sm text-un1t-subtle mt-1">
            Where this studio&apos;s leads come from. Add your own here (one per line, lower case, letters, digits, _ or -,
            no spaces) and they appear on the contact form, in audience filters and as a way onto a pipeline board.
            The standard sources and any source already on a contact are always offered.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-un1t-subtle mt-4"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</div>
          ) : (
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-un1t-subtle">This studio&apos;s own sources</span>
                <textarea
                  rows={4}
                  value={text}
                  disabled={!canEdit || saving}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="clubhouse_partner"
                  className="mt-1 block w-full rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
                />
              </label>
              {others.length > 0 && (
                <p className="text-xs text-un1t-subtle">
                  Also offered: {others.map((s) => s.value).join(', ')}
                </p>
              )}
              {canEdit && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || bad.length > 0 || tooMany || saving}
                    className="px-4 py-2 rounded-lg bg-un1t-accent text-white text-sm font-medium disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {savedFlash && <span className="flex items-center gap-1 text-sm text-green-700"><Check className="w-4 h-4" aria-hidden="true" /> Saved</span>}
                </div>
              )}
            </div>
          )}

          {bad.length > 0 && <p className="text-sm text-red-700 mt-2">Not a valid source (use letters, digits, _ or -, no spaces): {bad.join(', ')}</p>}
          {tooMany && <p className="text-sm text-red-700 mt-2">At most {MAX} sources.</p>}
          {error && (
            <p className="flex items-center gap-1 text-sm text-red-700 mt-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> {error}</p>
          )}
        </div>
      </div>
    </div>
  )
}

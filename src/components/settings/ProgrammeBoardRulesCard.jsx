'use client'

// PIPE3.8 — the Programmes pipeline board's entry rules (Settings → Locations
// → <name> → Details, below PayrollLieuCard): which landing-page lead sources
// and which Glofox trial plan names put a lead on the Programmes board instead
// of the Acquisition board. Renders nothing at a studio without that board.
// Reads + writes via /api/locations/[id]/pipeline-programmes.

import { useEffect, useState } from 'react'
import { Route, Loader2, Check, AlertTriangle } from 'lucide-react'

const toText = (list) => (Array.isArray(list) ? list.join('\n') : '')
const toList = (text) => [...new Set(String(text || '').split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean))]

export default function ProgrammeBoardRulesCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [hasBoard, setHasBoard] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [sources, setSources] = useState('')
  const [plans, setPlans] = useState('')
  const [saved, setSaved] = useState({ sources: '', plans: '' })
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/locations/${locationId}/pipeline-programmes`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j?.success) { setError(j?.error || 'Could not load the Programmes board rules'); return }
        const s = toText(j.data.lead_sources)
        const p = toText(j.data.glofox_plan_patterns)
        setHasBoard(Boolean(j.data.has_board))
        setCanEdit(Boolean(j.data.can_edit))
        setSources(s); setPlans(p); setSaved({ sources: s, plans: p })
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not load the Programmes board rules') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const dirty = sources !== saved.sources || plans !== saved.plans
  const tooMany = toList(sources).length > 20 || toList(plans).length > 20

  async function save() {
    if (tooMany) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/pipeline-programmes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_sources: toList(sources), glofox_plan_patterns: toList(plans) }),
      })
      const j = await res.json()
      if (!j?.success) { setError(j?.error || 'Could not save'); return }
      const s = toText(j.data.lead_sources)
      const p = toText(j.data.glofox_plan_patterns)
      setSources(s); setPlans(p); setSaved({ sources: s, plans: p })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch (e) {
      setError(e?.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  if (!loading && !hasBoard && !error) return null

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-xl p-5">
      <div className="flex items-start gap-3">
        <Route className="w-5 h-5 text-un1t-subtle mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-un1t-text">Programmes board</h3>
          <p className="text-sm text-un1t-subtle mt-1">
            Leads from these landing-page sources, or whose Glofox profile carries one of these trial plans, are placed on
            the Programmes board instead of the Acquisition board. Add the /postnatal page&apos;s lead source here when it goes live.
            One entry per line.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-un1t-subtle mt-4"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-un1t-subtle">Lead sources</span>
                <textarea
                  rows={4}
                  value={sources}
                  disabled={!canEdit || saving}
                  onChange={(e) => setSources(e.target.value)}
                  placeholder="meta_50plus"
                  className="mt-1 block w-full rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-un1t-subtle">Glofox trial plan names</span>
                <textarea
                  rows={4}
                  value={plans}
                  disabled={!canEdit || saving}
                  onChange={(e) => setPlans(e.target.value)}
                  placeholder="elites trial"
                  className="mt-1 block w-full rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
                />
              </label>
              <div className="sm:col-span-2 flex items-center gap-3">
                {canEdit && (
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || tooMany || saving}
                    className="px-4 py-2 rounded-lg bg-un1t-accent text-white text-sm font-medium disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
                {savedFlash && <span className="flex items-center gap-1 text-sm text-green-700"><Check className="w-4 h-4" aria-hidden="true" /> Saved</span>}
                <span className="text-xs text-un1t-subtle">A plan name matches as a part of the Glofox plan, so &ldquo;elites trial&rdquo; matches &ldquo;The Elites Trial&rdquo; and not &ldquo;Elite Membership&rdquo;.</span>
              </div>
            </div>
          )}

          {tooMany && <p className="text-sm text-red-700 mt-2">At most 20 entries in each list.</p>}
          {error && (
            <p className="flex items-center gap-1 text-sm text-red-700 mt-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> {error}</p>
          )}
        </div>
      </div>
    </div>
  )
}

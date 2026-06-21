'use client'

import { useState, useEffect } from 'react'

// INCLUSION-CORE T5 — operator editor for the UN1T-Points scoring
// figures: the five per-minute HR-zone point rates (Z1–Z5) plus the
// participation-points award for attending a class with no HR data.
// Manager+ only. Stored on locations.settings.scoring; read by the
// scoring engine (resolveScoringConfig). Mirrors the customer-agent
// settings page's primitives + dark-on-light tokens. Tuning the numbers
// is a settings write, not a code change.

const ZONE_IDS = [1, 2, 3, 4, 5]
const ZONE_LABELS = {
  1: 'Z1 — Warm-up',
  2: 'Z2 — Easy',
  3: 'Z3 — Aerobic',
  4: 'Z4 — Threshold',
  5: 'Z5 — Max',
}

export default function ScoringSettingsPage() {
  const [scoring, setScoring] = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/settings/scoring').then(r => r.json())
        if (cancelled) return
        if (res.success) {
          setScoring(res.scoring)
          setDefaults(res.defaults || null)
          setLocation(res.location || null)
        } else {
          setError(res.error || 'Failed to load')
        }
      } catch {
        if (!cancelled) setError('Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  function setZone(id, value) {
    setScoring(s => ({
      ...s,
      zone_points: { ...(s.zone_points || {}), [id]: value },
    }))
  }
  function setParticipation(value) {
    setScoring(s => ({ ...s, participation_points: value }))
  }

  async function saveSettings() {
    setSaving(true); setError(null)
    try {
      const payload = {
        zone_points: ZONE_IDS.reduce((acc, id) => {
          acc[id] = Number(scoring.zone_points?.[id] ?? 0)
          return acc
        }, {}),
        participation_points: Number(scoring.participation_points ?? 0),
      }
      const res = await fetch('/api/settings/scoring', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.success) { setSavedAt(Date.now()); if (j.scoring) setScoring(j.scoring) }
      else setError(j.error || 'Failed to save')
    } catch { setError('Failed to save') } finally { setSaving(false) }
  }

  if (loading || !scoring) return <div className="p-6 text-sm text-un1t-muted">Loading…</div>

  const inputCls = 'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text'
  const zoneDefaults = defaults?.zone_points || { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }
  const participationDefault = defaults?.participation_points ?? 50

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-un1t-text mb-1">Scoring</h1>
      <p className="text-sm text-un1t-muted mb-6">
        How UN1T Points are awarded at {location?.name || 'this studio'}. Members earn points per
        minute in each heart-rate zone, plus a flat participation award for attending a class without
        a heart-rate strap. Tune these to weight effort however you like — leave them at the defaults
        ({ZONE_IDS.map(id => zoneDefaults[id]).join(',')} per minute / {participationDefault} for
        participation) to keep the standard scoring.
      </p>

      <section className="space-y-5 border border-un1t-border rounded-lg p-5 mb-6">
        <div>
          <label className="block text-sm font-medium text-un1t-text mb-2">Points per minute, by heart-rate zone</label>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            {ZONE_IDS.map(id => (
              <div key={id}>
                <label className="block text-xs text-un1t-muted mb-1">{ZONE_LABELS[id]}</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  className={inputCls}
                  value={scoring.zone_points?.[id] ?? ''}
                  onChange={e => setZone(id, e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder={String(zoneDefaults[id])}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-un1t-subtle mt-2">
            A minute spent in a zone earns that many points. Defaults: {ZONE_IDS.map(id => `Z${id} ${zoneDefaults[id]}`).join(' · ')}.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-un1t-text mb-1">Participation points (no strap)</label>
          <input
            type="number"
            min={0}
            max={1000}
            step={5}
            className={inputCls}
            value={scoring.participation_points ?? ''}
            onChange={e => setParticipation(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder={String(participationDefault)}
          />
          <p className="text-xs text-un1t-subtle mt-1">
            Awarded when a member attends a class but has no heart-rate data to score from. Default: {participationDefault}.
          </p>
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div>
          <button onClick={saveSettings} disabled={saving}
            className="bg-un1t-text text-un1t-bg px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt && <span className="ml-3 text-sm text-green-600">Saved ✓</span>}
        </div>
      </section>
    </div>
  )
}

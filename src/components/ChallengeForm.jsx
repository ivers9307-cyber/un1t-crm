'use client'

// ChallengeForm — create/edit form for an engagement challenge.
// Used by /challenges (inline modal) for both create and edit flows.
//
// Post-start lock: once starts_on is today-or-past, mode/metric/dates
// are read-only — mirrors the API's PUT lock so the UI is honest about
// what the operator can actually change.

import { useState } from 'react'
import { AlertCircle, Loader2, Save } from 'lucide-react'
import { challengePhase } from '@/lib/challenges'

const inputCls =
  'w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text disabled:opacity-50'

const MODES = [
  { value: 'individual', label: 'Individual ranked' },
  { value: 'collective', label: 'Collective goal' },
]

const METRICS = [
  { value: 'points',         label: 'UN1T Points' },
  { value: 'classes',        label: 'Classes' },
  { value: 'z4plus_minutes', label: 'Z4+ minutes' },
]

export default function ChallengeForm({ challenge, locationId, onSaved }) {
  const isEditing = !!challenge

  // Post-start lock: mode/metric/dates become read-only once the
  // challenge has started (API enforces this; UI mirrors it).
  const started = isEditing && challengePhase(challenge) !== 'upcoming'

  const [name,     setName]     = useState(challenge?.name      || '')
  const [mode,     setMode]     = useState(challenge?.mode      || 'individual')
  const [metric,   setMetric]   = useState(challenge?.metric    || 'points')
  const [startsOn, setStartsOn] = useState(challenge?.starts_on || '')
  const [endsOn,   setEndsOn]   = useState(challenge?.ends_on   || '')
  const [target,   setTarget]   = useState(
    challenge?.target != null ? String(challenge.target) : ''
  )

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) { setError('Name is required.'); return }
    if (!started) {
      if (!startsOn) { setError('Start date is required.'); return }
      if (!endsOn)   { setError('End date is required.'); return }
      if (endsOn < startsOn) { setError('End date must be on or after start date.'); return }
    }
    if (mode === 'collective') {
      const t = Number(target)
      if (!target.trim() || !Number.isFinite(t) || !Number.isInteger(t) || t < 1) {
        setError('Collective challenges require a positive whole-number target.')
        return
      }
    }

    if (!isEditing && !locationId) {
      setError('No active location — please reload and try again.')
      return
    }

    setSaving(true)

    const payload = {
      name: name.trim(),
      ...(started ? {} : {
        mode,
        metric,
        starts_on: startsOn,
        ends_on:   endsOn,
      }),
      target: mode === 'collective' ? Number(target) : null,
    }

    if (!isEditing) {
      payload.location_id = locationId
    }

    const url    = isEditing ? `/api/challenges/${challenge.id}` : '/api/challenges'
    const method = isEditing ? 'PUT' : 'POST'

    const res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json()
    setSaving(false)

    if (!res.ok || json.success === false) {
      setError(json.error || `Save failed (${res.status})`)
      return
    }

    onSaved()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
          Challenge details
        </h3>

        {/* Name — always editable */}
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Name *</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="June Points Blitz"
            className={inputCls}
          />
        </div>

        {/* Mode — locked once started */}
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Mode *</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={started}
            className={inputCls}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          {started && (
            <p className="text-[11px] text-un1t-muted mt-1">
              Locked — challenge has already started.
            </p>
          )}
        </div>

        {/* Metric — locked once started */}
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Metric *</label>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            disabled={started}
            className={inputCls}
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>

        {/* Dates — locked once started */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Start date *</label>
            <input
              type="date"
              required={!started}
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              disabled={started}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">End date *</label>
            <input
              type="date"
              required={!started}
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              disabled={started}
              className={inputCls}
            />
          </div>
        </div>

        {/* Target — shown only for collective; always editable */}
        {mode === 'collective' && (
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">
              Collective target *
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="e.g. 10000"
              className="w-48 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[11px] text-un1t-muted mt-1">
              Total the group needs to hit together.
            </p>
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={saving}
        className="w-full inline-flex items-center justify-center gap-2 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create challenge'}
      </button>
    </form>
  )
}

'use client'

// FREQ-CAP.1 — per-location cross-channel marketing frequency cap card.
//
// Small operator card (Settings → Locations → <name> → Details, below
// LocationForm): an enable toggle + "minimum hours between marketing
// messages" number input (1–168; the server enforces the same zod
// bounds). OFF by default. When enabled, one contact receives at most
// one MARKETING touch — email campaign, WhatsApp blast/drip, or
// sequence email/WhatsApp step — per window; capped sends are DEFERRED
// (they go out once the window clears), and transactional messages
// (booking confirmations, reminders, 1:1 replies, Mia) are never
// affected.
//
// Reads + writes via /api/locations/[id]/comms-frequency-cap.

import { useEffect, useState } from 'react'
import { Gauge, Loader2, Check, AlertTriangle } from 'lucide-react'
import {
  FREQUENCY_CAP_MIN_HOURS,
  FREQUENCY_CAP_MAX_HOURS,
} from '@/lib/frequency-cap'

export default function CommsFrequencyCapCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [hours, setHours] = useState(24)
  const [saved, setSaved] = useState({ enabled: false, hours: 24 })
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/comms-frequency-cap`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          setEnabled(j.data.enabled)
          setHours(j.data.min_hours_between)
          setSaved({ enabled: j.data.enabled, hours: j.data.min_hours_between })
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

  const hoursNum = Number(hours)
  const hoursValid = Number.isInteger(hoursNum)
    && hoursNum >= FREQUENCY_CAP_MIN_HOURS
    && hoursNum <= FREQUENCY_CAP_MAX_HOURS
  const dirty = enabled !== saved.enabled || hoursNum !== saved.hours

  async function save() {
    if (!hoursValid || saving) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/comms-frequency-cap`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, min_hours_between: hoursNum }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        setEnabled(j.data.enabled)
        setHours(j.data.min_hours_between)
        setSaved({ enabled: j.data.enabled, hours: j.data.min_hours_between })
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
        <Loader2 size={14} className="animate-spin" /> Loading marketing frequency cap…
      </div>
    )
  }

  return (
    <section className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2">
            <Gauge size={14} className="text-un1t-subtle" />
            <h4 className="text-sm font-semibold text-un1t-text">Marketing frequency cap</h4>
          </div>
          <p className="text-xs text-un1t-subtle mt-1 max-w-md">
            When enabled, a contact receives at most one marketing message —
            email campaign, WhatsApp broadcast, or sequence step — per window.
            Capped sends are held and go out once the window clears. Booking
            confirmations, reminders and 1:1 replies are never affected.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable marketing frequency cap"
            onClick={() => setEnabled(v => !v)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
              enabled ? 'bg-un1t-text' : 'bg-un1t-border'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-un1t-bg transition-transform ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-un1t-text">
        <label htmlFor="freq-cap-hours" className={enabled ? '' : 'text-un1t-subtle'}>
          Minimum hours between marketing messages
        </label>
        <input
          id="freq-cap-hours"
          type="number"
          min={FREQUENCY_CAP_MIN_HOURS}
          max={FREQUENCY_CAP_MAX_HOURS}
          step={1}
          value={hours}
          disabled={!canEdit}
          onChange={(e) => setHours(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-20 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        />
        <span className="text-un1t-muted">({FREQUENCY_CAP_MIN_HOURS}–{FREQUENCY_CAP_MAX_HOURS})</span>
      </div>
      {!hoursValid && (
        <p className="mt-1 text-xs text-red-700">
          Hours must be a whole number between {FREQUENCY_CAP_MIN_HOURS} and {FREQUENCY_CAP_MAX_HOURS}.
        </p>
      )}

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
            disabled={!dirty || !hoursValid || saving}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-un1t-text text-un1t-bg font-semibold hover:bg-un1t-accent disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Save
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

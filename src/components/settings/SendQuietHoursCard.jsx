'use client'

// GAPS-P4 — per-location send-time quiet hours card.
//
// Settings -> Locations -> <name> -> Details, alongside the marketing
// frequency cap. Two hour pickers and an on/off switch, backed by
// company_settings.send_quiet_hours_* (mig 514). The window is what the
// composers warn against; nothing here changes what a send does.
//
// Deliberately operator-editable rather than a constant in the source: the
// hours a studio considers antisocial are a business decision, and a second
// location (or a second timezone) would need its own answer.
//
// Reads + writes via /api/locations/[id]/send-quiet-hours.

import { useEffect, useState } from 'react'
import { Moon, Loader2, Check, AlertTriangle } from 'lucide-react'
import { DEFAULT_SEND_QUIET_HOURS } from '@/lib/send-quiet-hours'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hhmm = (h) => `${String(h).padStart(2, '0')}:00`

export default function SendQuietHoursCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [enabled, setEnabled] = useState(DEFAULT_SEND_QUIET_HOURS.enabled)
  const [startHour, setStartHour] = useState(DEFAULT_SEND_QUIET_HOURS.startHour)
  const [endHour, setEndHour] = useState(DEFAULT_SEND_QUIET_HOURS.endHour)
  const [saved, setSaved] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/locations/${locationId}/send-quiet-hours`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok || !j.success) {
          setError(j.error || `HTTP ${res.status}`)
        } else {
          setEnabled(j.data.enabled)
          setStartHour(j.data.start_hour)
          setEndHour(j.data.end_hour)
          setSaved({ enabled: j.data.enabled, startHour: j.data.start_hour, endHour: j.data.end_hour })
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

  // start === end cannot be expressed: it is neither a zero-length nor a
  // 24-hour window. The DB CHECK rejects it too.
  const rangeValid = startHour !== endHour
  const dirty = !saved
    || enabled !== saved.enabled || startHour !== saved.startHour || endHour !== saved.endHour

  async function save() {
    if (!rangeValid || saving) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/send-quiet-hours`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, start_hour: startHour, end_hour: endHour }),
      })
      const j = await res.json()
      if (!res.ok || !j.success) {
        setError(j.error || `HTTP ${res.status}`)
      } else {
        setEnabled(j.data.enabled)
        setStartHour(j.data.start_hour)
        setEndHour(j.data.end_hour)
        setSaved({ enabled: j.data.enabled, startHour: j.data.start_hour, endHour: j.data.end_hour })
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
        <Loader2 size={14} className="animate-spin" /> Loading send quiet hours…
      </div>
    )
  }

  return (
    <section className="mt-6 bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2">
            <Moon size={14} className="text-un1t-subtle" />
            <h4 className="text-sm font-semibold text-un1t-text">Send quiet hours</h4>
          </div>
          <p className="text-xs text-un1t-subtle mt-1 max-w-md">
            When a campaign or broadcast would land inside this window, the
            composer says so and offers the next slot outside it. Nothing is
            blocked, delayed or rescheduled. Times are Europe/Dublin.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable send quiet hours"
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

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-un1t-text">
        <label htmlFor="quiet-start" className={enabled ? '' : 'text-un1t-subtle'}>Quiet from</label>
        <select
          id="quiet-start"
          value={startHour}
          disabled={!canEdit}
          onChange={(e) => setStartHour(Number(e.target.value))}
          className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        >
          {HOURS.map(h => <option key={h} value={h}>{hhmm(h)}</option>)}
        </select>
        <label htmlFor="quiet-end" className={enabled ? '' : 'text-un1t-subtle'}>until</label>
        <select
          id="quiet-end"
          value={endHour}
          disabled={!canEdit}
          onChange={(e) => setEndHour(Number(e.target.value))}
          className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text disabled:opacity-60"
        >
          {HOURS.map(h => <option key={h} value={h}>{hhmm(h)}</option>)}
        </select>
        <span className="text-un1t-muted">
          (default {hhmm(DEFAULT_SEND_QUIET_HOURS.startHour)} to {hhmm(DEFAULT_SEND_QUIET_HOURS.endHour)}
          {startHour > endHour ? ', crosses midnight' : ''})
        </span>
      </div>
      {!rangeValid && (
        <p className="mt-1 text-xs text-red-700">
          Pick two different hours. To turn the warning off, use the switch.
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
            disabled={!dirty || !rangeValid || saving}
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

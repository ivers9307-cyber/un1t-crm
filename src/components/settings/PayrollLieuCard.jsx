'use client'

// LIEU.1 — per-studio payroll rule card (Settings → Locations → <name> →
// Details, below GeofenceAttendanceCard): the Sunday time-in-lieu
// multiplier. A Sunday worked by an FTE employee banks shift hours × this
// figure as time in lieu (default 4/3, "time and a third"); a public holiday
// banks base time. Reads + writes via /api/locations/[id]/payroll.

import { useEffect, useState } from 'react'
import { CalendarClock, Loader2, Check, AlertTriangle } from 'lucide-react'

export default function PayrollLieuCard({ locationId }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [defaultValue, setDefaultValue] = useState(1.3333)
  const [bounds, setBounds] = useState({ min: 1, max: 3 })
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/locations/${locationId}/payroll`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (!j?.success) { setError(j?.error || 'Could not load the payroll rule'); return }
        const v = j.data.is_default ? '' : String(j.data.sunday_multiplier)
        setValue(v)
        setSaved(v)
        setDefaultValue(j.data.default_sunday_multiplier)
        setBounds({ min: j.data.min, max: j.data.max })
        setCanEdit(Boolean(j.data.can_edit))
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not load the payroll rule') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId])

  const dirty = value !== saved
  const parsed = value === '' ? null : Number(value)
  const invalid = value !== '' && (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max)

  async function save() {
    if (invalid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/payroll`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sunday_multiplier: parsed }),
      })
      const j = await res.json()
      if (!j?.success) { setError(j?.error || 'Could not save'); return }
      const v = j.data.is_default ? '' : String(j.data.sunday_multiplier)
      setValue(v)
      setSaved(v)
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
        <CalendarClock className="w-5 h-5 text-un1t-subtle mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-un1t-text">Sunday and public-holiday lieu time</h3>
          <p className="text-sm text-un1t-subtle mt-1">
            An FTE employee who works a Sunday banks their shift hours × this multiplier as time in lieu
            (Organisation of Working Time Act s.14). A public holiday worked banks base time (s.21).
            Credits are added nightly and show under each person&apos;s allowance. Contractors earn none.
          </p>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-un1t-subtle mt-4"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</div>
          ) : (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-xs uppercase tracking-wider text-un1t-subtle">Sunday multiplier</span>
                <input
                  type="number"
                  step="0.01"
                  min={bounds.min}
                  max={bounds.max}
                  value={value}
                  disabled={!canEdit || saving}
                  placeholder={String(defaultValue)}
                  onChange={(e) => setValue(e.target.value)}
                  className="mt-1 block w-32 rounded-lg border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text disabled:opacity-60"
                  aria-invalid={invalid || undefined}
                />
              </label>
              <span className="text-xs text-un1t-subtle pb-2">
                Blank = the default ({defaultValue}, time and a third). Allowed {bounds.min}–{bounds.max}.
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={save}
                  disabled={!dirty || invalid || saving}
                  className="px-4 py-2 rounded-lg bg-un1t-accent text-white text-sm font-medium disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              {savedFlash && <span className="flex items-center gap-1 text-sm text-green-700"><Check className="w-4 h-4" aria-hidden="true" /> Saved</span>}
            </div>
          )}

          {invalid && <p className="text-sm text-red-700 mt-2">Enter a number from {bounds.min} to {bounds.max}, or leave it blank for the default.</p>}
          {error && (
            <p className="flex items-center gap-1 text-sm text-red-700 mt-2"><AlertTriangle className="w-4 h-4" aria-hidden="true" /> {error}</p>
          )}
        </div>
      </div>
    </div>
  )
}

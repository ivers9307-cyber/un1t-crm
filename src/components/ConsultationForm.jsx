'use client'
// ConsultationForm.jsx — CONSULTATIONS SP1
//
// Create or edit a single consultation. Rendered inline by
// ConsultationsList (new) or per-row (edit). The notes field is labelled
// "Staff-internal notes" — consultations are NOT shared into the member
// app (only goals + photos + scans are, via the customer-self RLS).
//
// Props:
//   contactId    — string UUID of the contact
//   coaches      — Array<{ id, name }> for the coach <select>
//   consultation — existing row when editing; omit for a new consultation
//   selectedCoachId — default coach for a new consultation (current user)
//   onDone       — () => void; called after a successful save (close)
//   onCancel     — () => void; called when the form is dismissed
//
// POST (new) or PUT (edit) → consultations API; router.refresh() on
// success. Every non-submit button is type="button".

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { Button, Field } from '@/components/ui'

// timestamptz → "YYYY-MM-DD" for a <input type="date"> default.
function toDateInput(iso) {
  if (!iso) return new Date().toISOString().slice(0, 10)
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10)
  return d.toISOString().slice(0, 10)
}

export default function ConsultationForm({
  contactId,
  coaches = [],
  consultation = null,
  selectedCoachId = '',
  onDone,
  onCancel,
}) {
  const router = useRouter()
  const isEdit = Boolean(consultation?.id)

  const [date, setDate] = useState(toDateInput(consultation?.consulted_at))
  const [coachId, setCoachId] = useState(consultation?.coach_id || selectedCoachId || '')
  const [notes, setNotes] = useState(consultation?.notes || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    // Send consulted_at as a full ISO timestamp anchored at noon UTC of the
    // chosen day, so the date the operator picked survives a TZ round-trip
    // (the API accepts any ISO datetime string Postgres can parse).
    const body = {
      consulted_at: `${date}T12:00:00Z`,
      coach_id: coachId || undefined,
      notes: notes.trim() || undefined,
    }

    const url = isEdit
      ? `/api/contacts/${contactId}/consultations/${consultation.id}`
      : `/api/contacts/${contactId}/consultations`

    try {
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      router.refresh()
      onDone?.()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-un1t-border bg-un1t-bg/50 p-3">
      {error && (
        <p className="text-xs text-red-700 flex items-center gap-1">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field id={`consult-date-${consultation?.id || 'new'}`} label="Date">
          {(p) => (
            <input
              {...p}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
            />
          )}
        </Field>
        <Field id={`consult-coach-${consultation?.id || 'new'}`} label="Coach">
          {(p) => (
            <select
              {...p}
              value={coachId}
              onChange={(e) => setCoachId(e.target.value)}
              className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
            >
              <option value="">Unassigned</option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <Field id={`consult-notes-${consultation?.id || 'new'}`} label="Staff-internal notes">
        {(p) => (
          <textarea
            {...p}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What was discussed, agreed actions, observations…"
            className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
          />
        )}
      </Field>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={busy}>{isEdit ? 'Save' : 'Save consultation'}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onCancel?.()}>Cancel</Button>
      </div>
    </form>
  )
}

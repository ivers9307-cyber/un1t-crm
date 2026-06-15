'use client'
// ConsultationsList.jsx — CONSULTATIONS SP1
//
// Newest-first list of a contact's consultations (date · coach · notes),
// with a "New consultation" trigger and per-row Edit / Delete. Composes
// ConsultationForm for the create + edit forms.
//
// Props:
//   contactId     — string UUID of the contact
//   consultations — Array<consultations row> (the page already orders
//                   them newest-first, but we don't depend on that)
//   coaches       — Array<{ id, name }> for the coach select + name
//                   resolution
//   currentUserId — id of the signed-in user, used as the default coach
//                   for a new consultation
//
// Edit/Delete hit the consultations API; router.refresh() after a delete.
// Every non-submit button is type="button".

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquarePlus, AlertCircle } from 'lucide-react'
import { Card, Button } from '@/components/ui'
import ConsultationForm from '@/components/ConsultationForm'

function formatConsultDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ConsultationsList({ contactId, consultations = [], coaches = [], currentUserId = '' }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  // coach_id → display name lookup.
  const coachName = useMemo(() => {
    const m = new Map()
    for (const c of coaches) m.set(c.id, c.name)
    return m
  }, [coaches])

  // Defensive newest-first sort (page already does this server-side).
  const ordered = useMemo(
    () => [...consultations].sort((a, b) => String(b.consulted_at || '').localeCompare(String(a.consulted_at || ''))),
    [consultations],
  )

  async function deleteConsultation(cid) {
    if (!window.confirm('Delete this consultation?')) return
    setBusyId(cid)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/consultations/${cid}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card
      title="Consultations"
      actions={
        !adding && (
          <Button type="button" variant="secondary" size="sm" icon={MessageSquarePlus} onClick={() => { setAdding(true); setEditingId(null) }}>
            New consultation
          </Button>
        )
      }
    >
      {error && (
        <p className="text-xs text-red-700 mb-3 flex items-center gap-1">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {adding && (
        <div className="mb-4">
          <ConsultationForm
            contactId={contactId}
            coaches={coaches}
            selectedCoachId={currentUserId}
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {ordered.length === 0 && !adding && (
        <p className="text-sm text-un1t-subtle">No consultations logged yet.</p>
      )}

      <div className="divide-y divide-un1t-border/50">
        {ordered.map((c) => {
          if (editingId === c.id) {
            return (
              <div key={c.id} className="py-3">
                <ConsultationForm
                  contactId={contactId}
                  coaches={coaches}
                  consultation={c}
                  onDone={() => setEditingId(null)}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            )
          }
          const name = c.coach_id ? (coachName.get(c.coach_id) || 'Coach') : 'Unassigned'
          return (
            <div key={c.id} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-un1t-text">{formatConsultDate(c.consulted_at)}</span>
                  <span className="text-xs text-un1t-subtle truncate">· {name}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button type="button" variant="ghost" size="sm" disabled={busyId === c.id} onClick={() => { setEditingId(c.id); setAdding(false) }}>Edit</Button>
                  <Button type="button" variant="ghost" size="sm" loading={busyId === c.id} onClick={() => deleteConsultation(c.id)}>Delete</Button>
                </div>
              </div>
              {c.notes && <p className="text-sm text-un1t-subtle mt-1.5 whitespace-pre-wrap">{c.notes}</p>}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

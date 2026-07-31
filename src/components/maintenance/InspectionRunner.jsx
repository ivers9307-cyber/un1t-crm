'use client'

// EQUIP-MAINT.2 — the inspection run itself: a Modal that opens (or
// resumes) a draft, walks the inspector through the snapshot's
// checklist, and submits.
//
// Each Pass/Fail choice PATCHes the draft immediately (so a closed tab
// or dropped connection loses at most one tick), and the PATCH
// response — the full updated inspection row — becomes the new local
// source of truth for `draft.results`. Submit posts every result
// together as JSON, inside the same multipart request as the photos
// and the out-of-service flag.

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button, Field, Modal } from '@/components/ui'

const MAX_PHOTOS = 3

function orderedItems(draft) {
  if (!draft?.items) return []
  return [...draft.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export default function InspectionRunner({ equipmentId, equipmentName, onClose, onSubmitted }) {
  const [draft, setDraft] = useState(null)
  const [openError, setOpenError] = useState(null)
  const [opening, setOpening] = useState(true)

  const [editingNoteFor, setEditingNoteFor] = useState(null) // itemId currently showing its note textarea
  const [noteDrafts, setNoteDrafts] = useState({})           // itemId -> in-progress note text
  const [tickingId, setTickingId] = useState(null)
  const [tickErrors, setTickErrors] = useState({})
  const [missingIds, setMissingIds] = useState(new Set())

  const [overallNote, setOverallNote] = useState('')
  const [takeOutOfService, setTakeOutOfService] = useState(false)
  const [photos, setPhotos] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    let alive = true
    async function open() {
      setOpening(true)
      setOpenError(null)
      try {
        const res = await fetch(`/api/equipment/${equipmentId}/inspection`, { method: 'POST' })
          .then((r) => r.json())
        if (!alive) return
        if (res.success) setDraft(res.data)
        else setOpenError(res.error || 'Failed to open the inspection.')
      } catch (err) {
        // Without this catch, a network failure never reaches
        // setOpening(false) and the modal spins forever.
        if (alive) setOpenError(err.message || 'Failed to open the inspection.')
      } finally {
        if (alive) setOpening(false)
      }
    }
    open()
    return () => { alive = false }
  }, [equipmentId])

  const results = draft?.results || {}
  const hasAnyFail = Object.values(results).some((r) => r?.state === 'fail')

  // A fail was undone (switched back to pass, or resolved) — the
  // out-of-service flag no longer means anything, so don't leave a
  // stale checked-but-disabled control.
  useEffect(() => {
    if (!hasAnyFail) setTakeOutOfService(false)
  }, [hasAnyFail])

  async function tick(itemId, state, note) {
    setTickingId(itemId)
    setTickErrors((e) => ({ ...e, [itemId]: null }))
    try {
      const res = await fetch(`/api/equipment/inspections/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, state, ...(state === 'fail' ? { note } : {}) }),
      }).then((r) => r.json())
      if (!res.success) {
        setTickErrors((e) => ({ ...e, [itemId]: res.error || 'Failed to save.' }))
        return
      }
      setDraft((d) => ({ ...d, results: res.data.results }))
      setMissingIds((s) => {
        if (!s.has(itemId)) return s
        const next = new Set(s)
        next.delete(itemId)
        return next
      })
      if (editingNoteFor === itemId) setEditingNoteFor(null)
    } catch (err) {
      setTickErrors((e) => ({ ...e, [itemId]: err.message || 'Network error.' }))
    } finally {
      setTickingId(null)
    }
  }

  function markPass(itemId) {
    tick(itemId, 'pass')
  }

  function startFail(itemId) {
    setNoteDrafts((d) => ({ ...d, [itemId]: d[itemId] ?? results[itemId]?.note ?? '' }))
    setEditingNoteFor(itemId)
  }

  function saveFail(itemId) {
    const note = (noteDrafts[itemId] || '').trim()
    if (!note) return
    tick(itemId, 'fail', note)
  }

  function handlePhotoChange(e) {
    const files = Array.from(e.target.files || [])
    setPhotos(files.slice(0, MAX_PHOTOS))
  }

  function removePhoto(idx) {
    setPhotos((p) => p.filter((_, i) => i !== idx))
  }

  async function submit() {
    setSubmitError(null)
    setMissingIds(new Set())
    setSubmitting(true)
    try {
      const form = new FormData()
      form.append('results', JSON.stringify(draft.results || {}))
      form.append('note', overallNote.trim())
      form.append('takeOutOfService', String(takeOutOfService))
      photos.slice(0, MAX_PHOTOS).forEach((file, i) => form.append(`photo_${i}`, file))

      const res = await fetch(`/api/equipment/inspections/${draft.id}/submit`, {
        method: 'POST',
        body: form,
      }).then((r) => r.json())

      if (!res.success) {
        setSubmitError(res.error || 'Failed to submit the inspection.')
        if (Array.isArray(res.missing)) setMissingIds(new Set(res.missing))
        return
      }
      onSubmitted?.()
    } catch (err) {
      setSubmitError(err.message || 'Network error.')
    } finally {
      setSubmitting(false)
    }
  }

  const items = orderedItems(draft)
  const ready = !opening && !openError && draft

  return (
    <Modal
      open
      onClose={onClose}
      title={equipmentName ? `Inspect ${equipmentName}` : 'Inspection'}
      size="lg"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={submit} loading={submitting} disabled={!ready}>
            Submit
          </Button>
        </>
      }
    >
      {opening && <p className="py-8 text-center text-sm text-un1t-subtle">Loading…</p>}

      {openError && (
        <p className="inline-flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {openError}
        </p>
      )}

      {ready && (
        <div className="space-y-4">
          <ul className="space-y-3">
            {items.map((item) => {
              const result = results[item.id]
              const isPass = result?.state === 'pass'
              const isFail = result?.state === 'fail'
              const editing = editingNoteFor === item.id
              const missing = missingIds.has(item.id)
              const tickError = tickErrors[item.id]

              return (
                <li
                  key={item.id}
                  className={
                    'rounded-lg border p-3 ' +
                    (missing ? 'border-amber-500/50 bg-amber-500/5' : 'border-un1t-border')
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-un1t-text">{item.label}</p>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={isPass ? 'primary' : 'secondary'}
                        onClick={() => markPass(item.id)}
                        loading={tickingId === item.id && !editing}
                      >
                        Pass
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={isFail ? 'danger' : 'secondary'}
                        onClick={() => startFail(item.id)}
                      >
                        Fail
                      </Button>
                    </div>
                  </div>

                  {missing && (
                    <p className="mt-1 text-xs text-amber-700">Mark this check before submitting.</p>
                  )}
                  {tickError && (
                    <p className="mt-1 text-xs text-red-700">{tickError}</p>
                  )}

                  {editing && (
                    <div className="mt-2 space-y-2">
                      <textarea
                        autoFocus
                        rows={2}
                        maxLength={500}
                        className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                        placeholder="What's wrong? (required)"
                        value={noteDrafts[item.id] || ''}
                        onChange={(e) => setNoteDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                      />
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditingNoteFor(null)}>
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          onClick={() => saveFail(item.id)}
                          disabled={!(noteDrafts[item.id] || '').trim()}
                          loading={tickingId === item.id}
                        >
                          Save fault
                        </Button>
                      </div>
                    </div>
                  )}

                  {isFail && !editing && (
                    <p className="mt-1 text-xs text-un1t-subtle">{result.note}</p>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="space-y-3 border-t border-un1t-border pt-4">
            <Field
              id="inspection-photos"
              label="Photos"
              hint={hasAnyFail
                ? `Up to ${MAX_PHOTOS} photos of the fault.`
                : 'Only used when a check fails below.'}
            >
              <input
                id="inspection-photos"
                type="file"
                accept="image/*"
                multiple
                disabled={!hasAnyFail}
                onChange={handlePhotoChange}
                className="block w-full text-sm text-un1t-text disabled:opacity-50"
              />
              {photos.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {photos.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center justify-between text-xs text-un1t-subtle">
                      <span className="truncate">{f.name}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => removePhoto(i)}>Remove</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <Field id="inspection-note" label="Overall note" hint="Optional — included on the fault report, if any.">
              <textarea
                id="inspection-note"
                rows={2}
                maxLength={1000}
                className="w-full rounded border border-un1t-border px-2 py-1 text-sm"
                value={overallNote}
                onChange={(e) => setOverallNote(e.target.value)}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-un1t-text">
              <input
                type="checkbox"
                checked={takeOutOfService}
                disabled={!hasAnyFail}
                onChange={(e) => setTakeOutOfService(e.target.checked)}
              />
              Take out of service
              {!hasAnyFail && (
                <span className="text-xs text-un1t-subtle">(only available once a check has failed)</span>
              )}
            </label>

            {submitError && (
              <p className="inline-flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {submitError}
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

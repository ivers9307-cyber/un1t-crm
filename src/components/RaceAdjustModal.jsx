'use client'

// RaceAdjustModal — operator's manual override surface for a single
// race registration. Combines the three actions Richard called out:
//
//   1. Edit times — adjust race_started_at and/or race_finished_at
//      via datetime-local inputs prefilled with current values.
//      Setting the finish to empty = un-finish (clears finished_at,
//      keeps started_at — team goes back into "On Course" on the
//      next polling tick).
//   2. Add penalty — append a row to race_penalties (mig 124) with
//      signed seconds + reason. Multiple penalties supported per
//      Richard's spec; UI lists them with delete buttons (item 3).
//   3. Manage penalties — list + delete existing penalties for
//      operator undo. Delete is hard (no soft-delete) — the audit
//      trail is the row's existence.
//
// One modal for all three so the operator has a single "fix this
// team's data" surface instead of three separate buttons. Race-
// only by design (matches E7 of events expansion) — race-day
// timing semantics don't apply to workshops/seminars/etc., and
// the API enforces this.
//
// Props:
//   open: boolean
//   registration: { id, race_started_at, race_finished_at, penalties[] }
//                 — penalties[] embedded by /api/events/[id]/control-board
//                   in mig 124's API extension
//   teamName: string — display label
//   onClose: () => void
//   onChanged: () => void — caller refetches the board after save

import { useEffect, useState } from 'react'
import { Loader2, X as XIcon, Trash2, Plus, AlertCircle, Save } from 'lucide-react'

// Convert ISO timestamp to the local datetime-local input format
// (YYYY-MM-DDTHH:MM:SS, no zone). Empty string for null.
function isoToLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// And back. Empty input string -> null (the "un-finish" /
// "clear start" path). A valid local-time input gets parsed in the
// browser's tz then serialised as ISO UTC for the wire.
function localInputToIso(local) {
  if (!local || !local.trim()) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export default function RaceAdjustModal({ open, registration, teamName, onClose, onChanged }) {
  const [startInput,  setStartInput]  = useState('')
  const [finishInput, setFinishInput] = useState('')
  const [penaltySeconds, setPenaltySeconds] = useState('')
  const [penaltyReason,  setPenaltyReason]  = useState('')

  const [savingTimes, setSavingTimes] = useState(false)
  const [addingPen,   setAddingPen]   = useState(false)
  const [deletingId,  setDeletingId]  = useState(null)
  const [error, setError] = useState(null)

  // Re-prefill whenever the modal re-opens or the underlying
  // registration changes (board polling refresh). Avoids stale
  // values if the operator opens, the polling tick lands an
  // updated row, then the operator hits Save.
  useEffect(() => {
    if (!open) return
    setStartInput(isoToLocalInput(registration?.race_started_at))
    setFinishInput(isoToLocalInput(registration?.race_finished_at))
    setPenaltySeconds('')
    setPenaltyReason('')
    setError(null)
  }, [open, registration?.id, registration?.race_started_at, registration?.race_finished_at])

  if (!open) return null

  const penalties = Array.isArray(registration?.penalties) ? registration.penalties : []

  async function handleSaveTimes() {
    setError(null)
    setSavingTimes(true)
    try {
      const body = {
        started_at:  localInputToIso(startInput),
        finished_at: localInputToIso(finishInput),
      }
      const r = await fetch(`/api/registrations/${registration.id}/race-edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Save failed (${r.status})`)
      onChanged?.()
    } catch (e) {
      setError(`Times: ${e.message || 'failed'}`)
    } finally {
      setSavingTimes(false)
    }
  }

  async function handleAddPenalty() {
    setError(null)
    const sec = Number(penaltySeconds)
    if (!Number.isFinite(sec) || sec === 0) {
      setError('Penalty: enter a non-zero seconds value (positive penalty, negative credit).')
      return
    }
    if (!penaltyReason.trim()) {
      setError('Penalty: a reason is required.')
      return
    }
    setAddingPen(true)
    try {
      const r = await fetch(`/api/registrations/${registration.id}/penalties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: Math.round(sec), reason: penaltyReason.trim() }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Add failed (${r.status})`)
      setPenaltySeconds('')
      setPenaltyReason('')
      onChanged?.()
    } catch (e) {
      setError(`Penalty: ${e.message || 'failed'}`)
    } finally {
      setAddingPen(false)
    }
  }

  async function handleDeletePenalty(penaltyId) {
    setError(null)
    setDeletingId(penaltyId)
    try {
      const r = await fetch(`/api/registrations/${registration.id}/penalties/${penaltyId}`, { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Delete failed (${r.status})`)
      onChanged?.()
    } catch (e) {
      setError(`Delete: ${e.message || 'failed'}`)
    } finally {
      setDeletingId(null)
    }
  }

  const canUnFinish = !!registration?.race_finished_at
  function clearFinish() {
    setFinishInput('')
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-un1t-surface border border-un1t-border rounded-lg max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-un1t-border">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-un1t-subtle">Adjust race data</div>
            <div className="text-base font-semibold text-un1t-text">{teamName}</div>
          </div>
          <button onClick={onClose} className="text-un1t-subtle hover:text-un1t-text p-1">
            <XIcon size={18} />
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2 inline-flex items-start gap-2">
            <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Times */}
        <section className="px-5 py-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Times</h3>

          <div>
            <label className="block text-[11px] text-un1t-subtle mb-1">Race started at</label>
            <input
              type="datetime-local"
              step="1"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[10px] text-un1t-muted mt-1">Empty = clear (equivalent to Reset).</p>
          </div>

          <div>
            <label className="block text-[11px] text-un1t-subtle mb-1 flex items-center justify-between">
              <span>Race finished at</span>
              {canUnFinish && (
                <button
                  type="button"
                  onClick={clearFinish}
                  className="text-[10px] text-blue-400 hover:text-blue-300"
                  title="Un-finish — put this team back into On Course"
                >
                  Clear (un-finish)
                </button>
              )}
            </label>
            <input
              type="datetime-local"
              step="1"
              value={finishInput}
              onChange={(e) => setFinishInput(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[10px] text-un1t-muted mt-1">Empty + start kept = un-finish (team returns to On Course).</p>
          </div>

          <button
            type="button"
            onClick={handleSaveTimes}
            disabled={savingTimes}
            className="w-full inline-flex items-center justify-center gap-2 bg-un1t-text hover:bg-un1t-accent text-un1t-bg font-semibold text-sm py-2 rounded-md disabled:opacity-50"
          >
            {savingTimes ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {savingTimes ? 'Saving…' : 'Save times'}
          </button>
        </section>

        <div className="border-t border-un1t-border" />

        {/* Penalties */}
        <section className="px-5 py-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Penalties</h3>

          {penalties.length === 0 ? (
            <p className="text-[11px] text-un1t-muted">No penalties applied.</p>
          ) : (
            <ul className="space-y-1.5">
              {penalties.map((p) => {
                const sign = p.seconds > 0 ? '+' : ''
                const tone = p.seconds > 0 ? 'text-amber-700' : 'text-emerald-700'
                return (
                  <li key={p.id} className="flex items-center gap-2 text-sm bg-un1t-bg border border-un1t-border rounded-md px-3 py-2">
                    <span className={`font-mono font-semibold tabular-nums ${tone} min-w-[55px]`}>
                      {sign}{p.seconds}s
                    </span>
                    <span className="flex-1 text-un1t-subtle text-xs truncate" title={p.reason}>{p.reason}</span>
                    <button
                      type="button"
                      onClick={() => handleDeletePenalty(p.id)}
                      disabled={deletingId === p.id}
                      className="text-un1t-subtle hover:text-red-500 disabled:opacity-40 p-1"
                      title="Remove penalty"
                    >
                      {deletingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="grid grid-cols-[100px_1fr_auto] gap-2 items-start">
            <input
              type="number"
              step="1"
              min="-7200"
              max="7200"
              placeholder="+30"
              value={penaltySeconds}
              onChange={(e) => setPenaltySeconds(e.target.value)}
              title="Seconds — positive = penalty, negative = credit"
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text tabular-nums"
            />
            <input
              type="text"
              placeholder="Reason (e.g. missed 5 reps)"
              value={penaltyReason}
              onChange={(e) => setPenaltyReason(e.target.value)}
              maxLength={500}
              className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <button
              type="button"
              onClick={handleAddPenalty}
              disabled={addingPen}
              className="bg-un1t-text hover:bg-un1t-accent text-un1t-bg font-semibold text-sm px-3 py-2 rounded-md disabled:opacity-50 inline-flex items-center gap-1"
            >
              {addingPen ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Add
            </button>
          </div>
          <p className="text-[10px] text-un1t-muted">Positive seconds add to elapsed time (penalty); negative subtract (credit). Reason is required.</p>
        </section>
      </div>
    </div>
  )
}

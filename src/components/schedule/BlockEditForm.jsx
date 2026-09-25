'use client'
// BLOCKEDIT.1 — the manager's editor for ONE shift inside BlockDetailModal:
// start/end, min/max coaches, and the briefing its coaches read.
//
// Sends ONLY the fields the manager changed (D9: a field nobody touched is
// never overwritten from a stale form). The server owns every rule
// (src/lib/block-edit.js); this form shows its refusal inline. A max below the
// coaches already on the shift is a 409 the manager may override, the same
// "are you sure" the assign flow gives for a full shift.

import { useState } from 'react'
import { BRIEFING_MAX_LENGTH } from '@shared/shift-briefing'
import { isAdminShift } from '@shared/shift-kind'

const hhmm = (t) => String(t || '').slice(0, 5)
const inputCls = 'mt-1 w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1.5 text-sm text-un1t-text'
const labelCls = 'block text-[11px] font-semibold uppercase tracking-wider text-un1t-subtle'

export default function BlockEditForm({ block, onSave, onDone }) {
  const admin = isAdminShift(block)
  const initial = {
    start: hhmm(block.start_time),
    end: hhmm(block.end_time),
    min: String(block.min_coaches ?? 0),
    max: String(block.max_coaches ?? 1),
    briefing: block.briefing || '',
  }
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)
  const [min, setMin] = useState(initial.min)
  const [max, setMax] = useState(initial.max)
  const [briefing, setBriefing] = useState(initial.briefing)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function changedFields() {
    const out = {}
    if (start !== initial.start) out.start_time = start
    if (end !== initial.end) out.end_time = end
    if (!admin && min !== initial.min) out.min_coaches = Number(min)
    if (max !== initial.max) out.max_coaches = Number(max)
    if (briefing.trim() !== initial.briefing.trim()) out.briefing = briefing.trim() === '' ? null : briefing
    return out
  }

  async function send(payload) {
    setSaving(true)
    setError(null)
    const result = await onSave(payload)
    setSaving(false)
    if (result?.ok) { onDone(); return }
    if (result?.code === 'below_assigned' && !payload.allow_below_assigned) {
      if (confirm(`${result.error}\n\nSave anyway? Nobody is removed from the shift.`)) {
        await send({ ...payload, allow_below_assigned: true })
      }
      return
    }
    setError(result?.error || 'Could not save this shift')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const payload = changedFields()
    if (Object.keys(payload).length === 0) { onDone(); return }
    await send(payload)
  }

  return (
    <form aria-label="Edit shift" onSubmit={handleSubmit} className="mb-4 space-y-3 rounded-md border border-un1t-border bg-un1t-bg/40 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls} htmlFor="block-edit-start">Start</label>
          <input id="block-edit-start" type="time" required value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="block-edit-end">End</label>
          <input id="block-edit-end" type="time" required value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {admin ? (
          <p className="self-end text-xs text-un1t-subtle">Admin shifts have no minimum.</p>
        ) : (
          <div>
            <label className={labelCls} htmlFor="block-edit-min">Minimum coaches</label>
            <input id="block-edit-min" type="number" min={0} max={50} value={min} onChange={(e) => setMin(e.target.value)} className={inputCls} />
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="block-edit-max">Maximum coaches</label>
          <input id="block-edit-max" type="number" min={1} max={50} value={max} onChange={(e) => setMax(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="block-edit-briefing">Briefing for the coaches</label>
        <textarea
          id="block-edit-briefing"
          rows={3}
          maxLength={BRIEFING_MAX_LENGTH}
          value={briefing}
          onChange={(e) => setBriefing(e.target.value)}
          className={inputCls}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] text-un1t-subtle">
        <span>Every coach on this shift can read this.</span>
        <span>{briefing.length}/{BRIEFING_MAX_LENGTH}</span>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} disabled={saving} className="text-xs px-3 py-2 rounded-md border border-un1t-border text-un1t-text hover:bg-un1t-bg disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="text-xs px-3 py-2 rounded-md bg-blue-500/20 text-blue-700 border border-blue-500/40 hover:bg-blue-500/30 font-medium disabled:opacity-50">
          {saving ? 'Saving…' : 'Save shift'}
        </button>
      </div>
    </form>
  )
}

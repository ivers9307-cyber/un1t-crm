'use client'

// CLASS-TIMER PR2 — the segment editor. Build/edit a template's structure:
// segment + round blocks, per-block label/type/seconds, reorder, live total.
// All mutations go through the pure helpers in lib/timer-structure (tested);
// validation + total via the engine. Save POSTs (new) or PUTs (edit).

import { useState } from 'react'
import { X, Trash2, ChevronUp, ChevronDown, Repeat, Plus } from 'lucide-react'
import { TIMER_SEGMENT_TYPES, validateStructure, buildTimeline } from '@/lib/class-timer'
import {
  emptyStructure, newSegment, newRound,
  addBlock, removeBlock, moveBlock, updateBlock,
  addRoundSegment, removeRoundSegment, updateRoundSegment,
} from '@/lib/timer-structure'

export default function TimerTemplateEditor({ locationId, initial, onSaved, onCancel }) {
  const [name, setName] = useState(initial?.name || '')
  const [glofoxProgram, setGlofoxProgram] = useState(initial?.glofox_program || '')
  const [structure, setStructure] = useState(
    initial?.structure?.length ? initial.structure : emptyStructure(),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const valid = validateStructure(structure)
  const totalSeconds = valid.ok ? Math.round(buildTimeline(structure).totalMs / 1000) : 0
  const canSave = name.trim().length > 0 && valid.ok && !saving

  async function save() {
    setSaving(true); setError(null)
    try {
      const isEdit = !!initial?.id
      const url = isEdit ? `/api/timer/templates/${initial.id}` : '/api/timer/templates'
      const glofox_program = glofoxProgram.trim() || null
      const body = isEdit
        ? { name: name.trim(), structure, glofox_program }
        : { location_id: locationId, name: name.trim(), structure, glofox_program }
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not save')
      onSaved(j.template)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-un1t-border px-5 py-3">
          <h2 className="text-lg font-semibold">{initial?.id ? 'Edit timer' : 'New timer'}</h2>
          <button type="button" onClick={onCancel} className="rounded p-1 text-un1t-subtle hover:bg-un1t-surface" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
          <div>
            <label className="text-xs font-medium text-un1t-subtle">Name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DR1VE intervals"
              className="mt-1 w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-un1t-subtle">Link to a Glofox class <span className="font-normal">(optional)</span></label>
            <input
              value={glofoxProgram} onChange={(e) => setGlofoxProgram(e.target.value)} placeholder="e.g. DR1VE"
              className="mt-1 w-full rounded-md border border-un1t-border bg-white px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-un1t-subtle">
              When a class whose name contains this is live, the timer screens offer to load this timer in one tap.
            </p>
          </div>

          <div className="space-y-2">
            {structure.map((block, i) => block.kind === 'round' ? (
              <RoundBlock
                key={i} block={block} index={i} count={structure.length}
                onMove={(dir) => setStructure((s) => moveBlock(s, i, dir))}
                onDelete={() => setStructure((s) => removeBlock(s, i))}
                onCount={(c) => setStructure((s) => updateBlock(s, i, { count: c }))}
                onSeg={(k, patch) => setStructure((s) => updateRoundSegment(s, i, k, patch))}
                onAddSeg={() => setStructure((s) => addRoundSegment(s, i, { label: 'Work', type: 'work', seconds: 30 }))}
                onRemoveSeg={(k) => setStructure((s) => removeRoundSegment(s, i, k))}
              />
            ) : (
              <SegmentRow
                key={i} seg={block} index={i} count={structure.length}
                onMove={(dir) => setStructure((s) => moveBlock(s, i, dir))}
                onDelete={() => setStructure((s) => removeBlock(s, i))}
                onChange={(patch) => setStructure((s) => updateBlock(s, i, patch))}
              />
            ))}
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={() => setStructure((s) => addBlock(s, newSegment()))}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface">
              <Plus size={14} /> Segment
            </button>
            <button type="button" onClick={() => setStructure((s) => addBlock(s, newRound()))}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface">
              <Repeat size={14} /> Round
            </button>
          </div>

          {!valid.ok && <p className="text-xs text-amber-700">{valid.error}</p>}
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-un1t-border px-5 py-3">
          <p className="text-sm text-un1t-subtle">Total {fmtClock(totalSeconds * 1000)}</p>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm font-medium text-un1t-subtle hover:text-un1t-text">
              Cancel
            </button>
            <button type="button" disabled={!canSave} onClick={save}
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SegmentRow({ seg, index, count, onMove, onDelete, onChange }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-un1t-border bg-un1t-surface p-2">
      <input
        value={seg.label} onChange={(e) => onChange({ label: e.target.value })}
        className="min-w-0 flex-1 rounded border border-un1t-border bg-white px-2 py-1 text-sm"
      />
      <TypeSelect value={seg.type} onChange={(t) => onChange({ type: t })} />
      <SecondsInput value={seg.seconds} onChange={(n) => onChange({ seconds: n })} />
      <MoveDelete index={index} count={count} onMove={onMove} onDelete={onDelete} canDelete={count > 1} />
    </div>
  )
}

function RoundBlock({ block, index, count, onMove, onDelete, onCount, onSeg, onAddSeg, onRemoveSeg }) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-2">
      <div className="flex items-center gap-2">
        <Repeat size={14} className="text-indigo-700" />
        <span className="text-xs font-semibold text-indigo-700">Repeat</span>
        <input
          type="number" min={1} max={99} value={block.count}
          onChange={(e) => onCount(clampInt(e.target.value, 1, 99))}
          className="w-16 rounded border border-un1t-border bg-white px-2 py-1 text-sm"
        />
        <span className="text-xs text-un1t-subtle">×</span>
        <div className="ml-auto">
          <MoveDelete index={index} count={count} onMove={onMove} onDelete={onDelete} canDelete />
        </div>
      </div>
      <div className="mt-2 space-y-1.5 pl-5">
        {block.segments.map((s, k) => (
          <div key={k} className="flex items-center gap-2">
            <input
              value={s.label} onChange={(e) => onSeg(k, { label: e.target.value })}
              className="min-w-0 flex-1 rounded border border-un1t-border bg-white px-2 py-1 text-sm"
            />
            <TypeSelect value={s.type} onChange={(t) => onSeg(k, { type: t })} />
            <SecondsInput value={s.seconds} onChange={(n) => onSeg(k, { seconds: n })} />
            <button
              type="button" onClick={() => onRemoveSeg(k)} disabled={block.segments.length <= 1}
              className="rounded p-1 text-un1t-subtle hover:bg-white disabled:opacity-30" aria-label="Remove segment"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={onAddSeg} className="text-xs font-medium text-indigo-700 hover:underline">
          + add segment
        </button>
      </div>
    </div>
  )
}

function TypeSelect({ value, onChange }) {
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      className="rounded border border-un1t-border bg-white px-2 py-1 text-sm capitalize"
    >
      {TIMER_SEGMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  )
}

function SecondsInput({ value, onChange }) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number" min={1} max={3600} value={value}
        onChange={(e) => onChange(clampInt(e.target.value, 1, 3600))}
        className="w-16 rounded border border-un1t-border bg-white px-2 py-1 text-sm tabular-nums"
      />
      <span className="text-xs text-un1t-subtle">s</span>
    </div>
  )
}

function MoveDelete({ index, count, onMove, onDelete, canDelete }) {
  return (
    <div className="flex items-center">
      <button type="button" onClick={() => onMove('up')} disabled={index === 0}
        className="rounded p-1 text-un1t-subtle hover:bg-white disabled:opacity-30" aria-label="Move up">
        <ChevronUp size={14} />
      </button>
      <button type="button" onClick={() => onMove('down')} disabled={index === count - 1}
        className="rounded p-1 text-un1t-subtle hover:bg-white disabled:opacity-30" aria-label="Move down">
        <ChevronDown size={14} />
      </button>
      <button type="button" onClick={onDelete} disabled={!canDelete}
        className="rounded p-1 text-un1t-subtle hover:bg-white disabled:opacity-30" aria-label="Delete block">
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function clampInt(raw, min, max) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

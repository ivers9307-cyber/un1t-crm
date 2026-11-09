'use client'
// RegistrationQuestionsEditor — QUESTIONS.1. Rows of registration questions
// (label, type, options for a choice, required, asked per entry or per
// person), emitting the race_events.registration_questions shape; ids are
// minted here. Shared by the host form (dark) and the staff RaceEventForm
// (light): only the surface differs.

import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { HOST_LABEL, HOST_WELL, HOST_HINT, HOST_INPUT } from '@/components/host/host-ui'
import { MAX_QUESTIONS } from '@/lib/registration-questions'

const blank = () => ({ id: `q-${Math.random().toString(36).slice(2, 10)}`, label: '', type: 'text', required: false, per: 'entry' })
const parseOptions = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10)

export default function RegistrationQuestionsEditor({ value, onChange, dark = false }) {
  const qs = Array.isArray(value) ? value : []
  const input = dark
    ? HOST_INPUT
    : 'w-full bg-un1t-bg border border-un1t-border rounded-md px-2.5 py-2 text-sm text-un1t-text'
  const label = dark ? `${HOST_LABEL} mb-1` : 'block text-[11px] text-un1t-subtle mb-1'
  const ghost = dark ? 'text-host-hint hover:text-host-text' : 'text-un1t-subtle hover:text-un1t-text'
  const card = dark ? HOST_WELL : 'rounded-md border border-un1t-border bg-un1t-surface p-3'
  const hint = dark ? HOST_HINT : 'text-[11px] text-un1t-muted'

  const update = (i, patch) => onChange(qs.map((q, j) => {
    if (j !== i) return q
    const next = { ...q, ...patch }
    if (next.type !== 'choice') delete next.options
    return next
  }))
  const remove = (i) => onChange(qs.filter((_, j) => j !== i))
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= qs.length) return
    const next = [...qs]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {qs.map((q, i) => (
        <div key={q.id} className={card}>
          <div className="grid grid-cols-2 sm:grid-cols-[2fr_1fr_1fr_auto] gap-2 items-end">
            <div className="col-span-2 sm:col-span-1">
              <label htmlFor={`${q.id}-label`} className={label}>Question {i + 1} label</label>
              <input id={`${q.id}-label`} type="text" maxLength={120} value={q.label || ''} onChange={(e) => update(i, { label: e.target.value })} placeholder="Dietary needs" className={input} />
            </div>
            <div>
              <label htmlFor={`${q.id}-type`} className={label}>Question {i + 1} type</label>
              <select id={`${q.id}-type`} value={q.type} onChange={(e) => update(i, { type: e.target.value, ...(e.target.value === 'choice' ? { options: q.options || [] } : {}) })} className={input}>
                <option value="text">Text</option>
                <option value="choice">Choice</option>
                <option value="yes_no">Yes / no</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${q.id}-per`} className={label}>Question {i + 1} asked</label>
              <select id={`${q.id}-per`} value={q.per || 'entry'} onChange={(e) => update(i, { per: e.target.value })} className={input}>
                <option value="entry">Once per booking</option>
                <option value="person">For each person</option>
              </select>
            </div>
            <div className="flex items-center gap-1 justify-end">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`} className={`p-1.5 ${ghost} disabled:opacity-30`}><ArrowUp size={14} /></button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === qs.length - 1} aria-label={`Move question ${i + 1} down`} className={`p-1.5 ${ghost} disabled:opacity-30`}><ArrowDown size={14} /></button>
              <button type="button" onClick={() => remove(i)} aria-label={`Remove question ${i + 1}`} className={`p-1.5 ${ghost}`}><X size={14} /></button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-2 mt-2 items-end">
            {q.type === 'choice' ? (
              <div>
                <label htmlFor={`${q.id}-options`} className={label}>Question {i + 1} options (comma-separated)</label>
                <input id={`${q.id}-options`} type="text" value={(q.options || []).join(', ')} onChange={(e) => update(i, { options: parseOptions(e.target.value) })} placeholder="S, M, L, XL" className={input} />
              </div>
            ) : <div />}
            <label className={`inline-flex items-center gap-2 text-sm ${dark ? 'text-host-text' : 'text-un1t-text'}`}>
              <input type="checkbox" checked={!!q.required} onChange={(e) => update(i, { required: e.target.checked })} aria-label={`Question ${i + 1} required`} />
              Required
            </label>
          </div>
        </div>
      ))}
      {qs.length < MAX_QUESTIONS && (
        <button type="button" onClick={() => onChange([...qs, blank()])} className={`text-sm underline underline-offset-2 ${ghost}`}>
          + Add a question
        </button>
      )}
      <p className={hint}>
        Asked at signup, in this order. A per-person question is asked for everyone on the booking; answers appear on the attendee list and in the export.
      </p>
    </div>
  )
}

'use client'

// CLASS-TIMER PR1 — basic coach control. Pick a template, Start, then
// Pause/Resume/Skip/Stop; the live readout uses the same pure engine the TV
// banner does. PR1 ships preset templates only; the rich segment editor is PR2.

import { useEffect, useMemo, useState } from 'react'
import { Play, Pause, Square, SkipForward, SkipBack, Plus, Pencil, Trash2 } from 'lucide-react'
import { buildTimeline, computeEffectiveElapsedMs, resolveTimerState } from '@/lib/class-timer'
import TimerTemplateEditor from '@/components/TimerTemplateEditor'

const POLL_MS = 2000

// Ready-made structures so there's something to run before the PR2 editor lands.
const PRESETS = [
  { name: 'Tabata — 8 × (20/10)', structure: [
    { kind: 'segment', label: 'Get ready', type: 'prep', seconds: 10 },
    { kind: 'round', count: 8, segments: [
      { label: 'Work', type: 'work', seconds: 20 },
      { label: 'Rest', type: 'rest', seconds: 10 },
    ] },
  ] },
  { name: 'Intervals — 10 × (45/15)', structure: [
    { kind: 'segment', label: 'Get ready', type: 'prep', seconds: 10 },
    { kind: 'round', count: 10, segments: [
      { label: 'Work', type: 'work', seconds: 45 },
      { label: 'Rest', type: 'rest', seconds: 15 },
    ] },
  ] },
  { name: 'EMOM — 10 min', structure: [
    { kind: 'round', count: 10, segments: [{ label: 'Minute', type: 'work', seconds: 60 }] },
  ] },
]

export default function TimerControlClient({ locationId }) {
  const [templates, setTemplates] = useState([])
  const [run, setRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // null | 'new' | template object

  async function loadTemplates() {
    try {
      const r = await fetch(`/api/timer/templates?location_id=${locationId}`, { cache: 'no-store' })
      const j = await r.json()
      if (j.success) setTemplates(j.templates || [])
    } catch { /* transient */ }
  }
  async function loadActive() {
    try {
      const r = await fetch(`/api/timer/active?location_id=${locationId}`, { cache: 'no-store' })
      const j = await r.json()
      if (j.success) setRun(j.run || null)
    } catch { /* transient */ }
  }

  useEffect(() => {
    loadTemplates()
    loadActive()
    const t = setInterval(loadActive, POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  async function createPreset(preset) {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/timer/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, name: preset.name, structure: preset.structure }),
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not create template')
      await loadTemplates()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function start(templateId) {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/timer/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, template_id: templateId }),
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not start')
      setRun(j.run)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function control(action, direction) {
    if (!run) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/timer/runs/${run.id}/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, direction }),
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Action failed')
      setRun(j.run?.status === 'stopped' ? null : j.run)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function deleteTemplate(id) {
    if (!confirm('Delete this timer?')) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/timer/templates/${id}`, { method: 'DELETE' })
      const j = await r.json()
      if (!j.success) throw new Error(j.error || 'Could not delete')
      await loadTemplates()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const existingNames = new Set(templates.map((t) => t.name))

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}

      {run ? (
        <RunControl run={run} busy={busy} onControl={control} />
      ) : (
        <section className="rounded-2xl border border-un1t-border bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Start a timer</h3>
            <button type="button" onClick={() => setEditing('new')}
              className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-2.5 py-1 text-xs font-medium hover:bg-un1t-surface">
              <Plus size={13} /> New timer
            </button>
          </div>
          {templates.length === 0 ? (
            <p className="mt-1 text-sm text-un1t-subtle">No timers yet — build one, or quick-add a preset below.</p>
          ) : (
            <ul className="mt-3 divide-y divide-un1t-border">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.name}</p>
                    <p className="text-xs text-un1t-subtle">{fmtClock((t.total_seconds || 0) * 1000)} total</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" disabled={busy} onClick={() => setEditing(t)}
                      className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface" aria-label="Edit">
                      <Pencil size={15} />
                    </button>
                    <button type="button" disabled={busy} onClick={() => deleteTemplate(t.id)}
                      className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface" aria-label="Delete">
                      <Trash2 size={15} />
                    </button>
                    <button
                      type="button" disabled={busy} onClick={() => start(t.id)}
                      className="ml-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      <Play size={14} /> Start
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!run && (
        <section className="rounded-2xl border border-un1t-border bg-white p-5">
          <h3 className="text-sm font-semibold">Quick add a preset</h3>
          <p className="mt-1 text-xs text-un1t-subtle">Seed a common format, then tweak it with the editor.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.name} type="button" disabled={busy || existingNames.has(p.name)} onClick={() => createPreset(p)}
                className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface disabled:opacity-40"
              >
                <Plus size={14} /> {p.name}{existingNames.has(p.name) ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </section>
      )}

      {editing && (
        <TimerTemplateEditor
          locationId={locationId}
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadTemplates() }}
        />
      )}
    </div>
  )
}

function RunControl({ run, busy, onControl }) {
  const timeline = useMemo(
    () => (run?.structure_snapshot ? buildTimeline(run.structure_snapshot) : null),
    [run],
  )
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])
  if (!timeline) return null
  const nowMs = Date.now() // coach device clock is online + fine for control
  const st = resolveTimerState(timeline, computeEffectiveElapsedMs(run, nowMs))
  const paused = run.status === 'paused'

  return (
    <section className="rounded-2xl border border-un1t-border bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="truncate text-sm font-semibold">{run.name || 'Class timer'}</p>
        {paused && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Paused</span>}
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="text-4xl font-bold tabular-nums">
          {st.finished ? 'Done' : fmtClock(st.segmentRemainingMs)}
        </span>
        {!st.finished && <span className="text-lg font-medium text-un1t-subtle">{st.currentStep?.label}</span>}
      </div>
      <p className="mt-1 text-xs text-un1t-subtle">
        {st.roundCount ? `Round ${st.roundIndex}/${st.roundCount} · ` : ''}
        {st.nextStep && !st.finished ? `next: ${st.nextStep.label} ${fmtClock(st.nextStep.seconds * 1000)} · ` : ''}
        {fmtClock(st.totalElapsedMs)} / {fmtClock(st.totalRemainingMs)} total
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => onControl('skip', 'prev')}
          className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface disabled:opacity-50">
          <SkipBack size={14} /> Prev
        </button>
        {paused ? (
          <button type="button" disabled={busy} onClick={() => onControl('resume')}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            <Play size={14} /> Resume
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => onControl('pause')}
            className="inline-flex items-center gap-1.5 rounded-md bg-un1t-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            <Pause size={14} /> Pause
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onControl('skip', 'next')}
          className="inline-flex items-center gap-1.5 rounded-md border border-un1t-border px-3 py-1.5 text-sm font-medium hover:bg-un1t-surface disabled:opacity-50">
          Next <SkipForward size={14} />
        </button>
        <button type="button" disabled={busy} onClick={() => onControl('stop')}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
          <Square size={14} /> Stop
        </button>
      </div>
    </section>
  )
}

// ms → "m:ss"
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

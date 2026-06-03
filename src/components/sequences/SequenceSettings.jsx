'use client'

// FLOW-GRAPH Phase 2 (PR3c) — sequence settings panel inside the builder, so
// operators can rename / pause / set a goal / send-window / cooldown without the
// classic editor. Saves via the existing PUT /api/sequences/[id]. Trigger editing
// is intentionally NOT here yet — the trigger-type taxonomy is inconsistent across
// the graph schema, the PUT route enum, and the runner, and needs reconciling
// first; the trigger card stays read-only + the classic editor handles it for now.
import { useState } from 'react'
import { ChevronDown, ChevronRight, Save, Check, AlertTriangle, Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui'
import { Labeled, Text, Area, Num, Select } from './nodeEditing'

const PIPELINE_SLUGS = [
  'new_lead', 'active_trial', 'hot_conversion', 'active_member',
  'at_risk_member', 'classpass_active', 'lapsed', 'dormant', 'dormant_classpass',
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function SequenceSettings({ sequence }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(sequence?.name || '')
  const [status, setStatus] = useState(sequence?.status || 'draft')
  const [description, setDescription] = useState(sequence?.description || '')
  const [goal, setGoal] = useState(sequence?.goal_config || null)
  const [windowOn, setWindowOn] = useState(!!sequence?.send_window)
  const [win, setWin] = useState(sequence?.send_window || { start_hour: 9, end_hour: 20, skip_days: [] })
  const [cooldown, setCooldown] = useState(sequence?.re_enrolment_cooldown_days ?? 0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const touch = () => { setDirty(true); setFeedback(null) }
  const goalType = goal?.type || ''
  const setGoalType = (t) => {
    setGoal(t === '' ? null : { type: t, ...(t === 'pipeline_stage' ? { value: PIPELINE_SLUGS[0] } : {}) })
    touch()
  }
  const toggleSkipDay = (d) => {
    const cur = new Set(win.skip_days || [])
    cur.has(d) ? cur.delete(d) : cur.add(d)
    setWin({ ...win, skip_days: [...cur].sort((a, b) => a - b) }); touch()
  }

  const save = async () => {
    setBusy(true)
    try {
      const payload = {
        name: name || 'Untitled Sequence',
        status,
        description: description || null,
        goal_config: goal,
        send_window: windowOn ? win : null,
        re_enrolment_cooldown_days: Math.max(0, Math.min(3650, parseInt(cooldown, 10) || 0)),
      }
      const res = await fetch(`/api/sequences/${sequence.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (data.success) { setDirty(false); setFeedback({ ok: true, text: 'Settings saved' }) }
      else setFeedback({ ok: false, text: data.error || 'Could not save settings' })
    } catch { setFeedback({ ok: false, text: 'Network error saving settings' }) } finally { setBusy(false) }
  }

  return (
    <div className="max-w-md mx-auto mb-4 border border-un1t-border rounded-lg bg-un1t-surface">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={15} className="text-un1t-subtle" /> : <ChevronRight size={15} className="text-un1t-subtle" />}
        <SettingsIcon size={15} className="text-un1t-subtle" />
        <span className="text-sm font-medium text-un1t-text">Settings</span>
        <span className="ml-auto text-xs text-un1t-subtle capitalize">{status}{dirty ? ' • unsaved' : ''}</span>
      </button>
      {open && (
        <div className="border-t border-un1t-border px-4 py-3 space-y-3">
          <Labeled label="Name"><Text value={name} onChange={v => { setName(v); touch() }} placeholder="Sequence name" /></Labeled>
          <Labeled label="Status">
            <Select value={status} onChange={v => { setStatus(v); touch() }} options={[['draft', 'Draft'], ['active', 'Active'], ['paused', 'Paused'], ['archived', 'Archived']]} />
          </Labeled>

          <Labeled label="Goal — auto-exit when…" hint="The contact leaves the sequence early once this is met.">
            <Select value={goalType} onChange={setGoalType} options={[['', 'No goal'], ['pipeline_stage', 'Reaches a pipeline stage'], ['tag_added', 'Gets a tag'], ['booking_made', 'Books an event']]} />
          </Labeled>
          {goalType === 'pipeline_stage' && (
            <Labeled label="Stage"><Select value={goal.value || PIPELINE_SLUGS[0]} onChange={v => { setGoal({ ...goal, value: v }); touch() }} options={PIPELINE_SLUGS} /></Labeled>
          )}
          {goalType === 'tag_added' && (
            <Labeled label="Tag"><Text value={goal.tag} onChange={v => { setGoal({ ...goal, tag: v }); touch() }} placeholder="e.g. race_completed" /></Labeled>
          )}

          <div>
            <label className="flex items-center gap-2 text-xs font-medium text-un1t-subtle">
              <input type="checkbox" checked={windowOn} onChange={e => { setWindowOn(e.target.checked); touch() }} />
              Only send during set hours
            </label>
            {windowOn && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Labeled label="From (hour, 0–23)"><Num value={win.start_hour} onChange={v => { setWin({ ...win, start_hour: v }); touch() }} max={23} /></Labeled>
                  <Labeled label="To (hour, 0–23)"><Num value={win.end_hour} onChange={v => { setWin({ ...win, end_hour: v }); touch() }} max={23} /></Labeled>
                </div>
                <div>
                  <span className="block text-xs font-medium text-un1t-subtle mb-1">Skip days</span>
                  <div className="flex gap-1">
                    {DAYS.map((d, i) => (
                      <button key={i} type="button" onClick={() => toggleSkipDay(i)}
                        className={`px-2 py-1 rounded text-xs transition-colors ${(win.skip_days || []).includes(i) ? 'bg-rose-500/15 text-rose-700' : 'bg-un1t-border/40 text-un1t-subtle hover:text-un1t-text'}`}>{d}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <Labeled label="Re-enrolment cooldown (days)" hint="0 = enrol each contact once. N = they can re-enter after N days.">
            <Num value={cooldown} onChange={v => { setCooldown(v); touch() }} max={3650} />
          </Labeled>
          <Labeled label="Internal note"><Area value={description} onChange={v => { setDescription(v); touch() }} rows={2} placeholder="Optional memo for your team" /></Labeled>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={save} variant="primary" size="sm" icon={Save} loading={busy} disabled={!dirty || busy}>Save settings</Button>
            {feedback && <span className={`text-xs flex items-center gap-1 ${feedback.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{feedback.ok ? <Check size={13} /> : <AlertTriangle size={13} />}{feedback.text}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

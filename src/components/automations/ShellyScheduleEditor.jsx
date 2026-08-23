// SHELLY-UI.6 — what runs this plug: nothing, fixed windows, or the class
// timetable.
//
// PATCHES ONLY WHAT CHANGED. `ShellyDevicePatch` refuses an empty body and
// every field it carries is written, so sending the whole draft would rewrite
// `class_rule` (and its engine defaults for lead/lag) every time an operator
// touched a window. The diff below is what keeps "I edited the windows" from
// meaning "I also re-asserted the pre-heat".
//
// THE OVERLAP AND SAME-BOUNDARY RULES ARE NOT CHECKED HERE. They live in
// src/lib/schedule/windows.js and run on the server, so the answer an operator
// gets is the one the engine will act on — a client-side copy is a second
// implementation that can only drift. The 400 comes back with the sentence in
// `issues[0].message`, which is exactly what errorText reaches for first.

'use client'

import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui'
import { MAX_FIXED_WINDOWS, MAX_CLASS_LEAD_LAG_MIN, DEFAULT_LEAD_MIN, DEFAULT_LAG_MIN } from '@/lib/shelly/schemas'
import WindowsEditor from './WindowsEditor'

const MODES = [
  { value: 'none', label: 'No schedule', hint: 'The plug stays wherever you leave it.' },
  { value: 'fixed', label: 'Fixed windows', hint: 'On and off at set times on set days.' },
  { value: 'class', label: 'Class timetable', hint: 'On before each class and off after it.' },
]

const GLOFOX_HINT = 'Connect Glofox to use class-linked schedules'

const clampMin = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_CLASS_LEAD_LAG_MIN, Math.max(0, Math.trunc(n)))
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export default function ShellyScheduleEditor({ device, glofoxConnected, onSave }) {
  const [mode, setMode] = useState(device.schedule_mode || 'none')
  const [windows, setWindows] = useState(Array.isArray(device.fixed_windows) ? device.fixed_windows : [])
  const [lead, setLead] = useState(device.class_rule?.lead_min ?? DEFAULT_LEAD_MIN)
  const [lag, setLag] = useState(device.class_rule?.lag_min ?? DEFAULT_LAG_MIN)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const storedWindows = Array.isArray(device.fixed_windows) ? device.fixed_windows : []
  const storedRule = {
    lead_min: device.class_rule?.lead_min ?? DEFAULT_LEAD_MIN,
    lag_min: device.class_rule?.lag_min ?? DEFAULT_LAG_MIN,
  }

  function buildPatch() {
    const patch = {}
    if (mode !== (device.schedule_mode || 'none')) patch.schedule_mode = mode
    // The windows only travel with a fixed schedule, and the rule only with a
    // class one — sending the other would write a field the operator was not
    // looking at.
    if (mode === 'fixed' && !sameJson(windows, storedWindows)) patch.fixed_windows = windows
    if (mode === 'class') {
      const rule = { lead_min: clampMin(lead), lag_min: clampMin(lag) }
      if (!sameJson(rule, storedRule)) patch.class_rule = rule
    }
    return patch
  }

  const patch = buildPatch()
  const dirty = Object.keys(patch).length > 0

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    const res = await onSave(patch)
    setBusy(false)
    if (!res?.ok) {
      setError(res?.message || 'Could not save this schedule')
      return
    }
    setSaved(true)
  }

  // Enter saves, Escape puts the field back to what is stored. A number field
  // that swallows Enter reads as broken, and a typo needs an undo that is not
  // "remember what it was".
  function onRuleKeyDown(e, reset) {
    if (e.key === 'Enter') { e.preventDefault(); if (dirty) save() }
    if (e.key === 'Escape') { e.preventDefault(); reset() }
  }

  function pickMode(next) {
    setMode(next)
    setSaved(false)
    setError(null)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {MODES.map((m) => {
          const disabled = m.value === 'class' && !glofoxConnected
          return (
            <label
              key={m.value}
              title={disabled ? GLOFOX_HINT : m.hint}
              className={`inline-flex items-center gap-1.5 text-xs ${disabled ? 'text-un1t-muted' : 'text-un1t-text'}`}
            >
              <input
                type="radio"
                name={`shelly-mode-${device.id}`}
                value={m.value}
                checked={mode === m.value}
                disabled={disabled}
                onChange={() => pickMode(m.value)}
              />
              {m.label}
            </label>
          )
        })}
      </div>

      {mode === 'fixed' && (
        <WindowsEditor
          windows={windows}
          onChange={(next) => { setWindows(next); setSaved(false) }}
          editable
          max={MAX_FIXED_WINDOWS}
        />
      )}

      {mode === 'class' && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <label className="inline-flex items-center gap-1 text-xs text-un1t-subtle">
            On
            <input
              type="number"
              min={0}
              max={MAX_CLASS_LEAD_LAG_MIN}
              value={lead}
              disabled={!glofoxConnected}
              title={!glofoxConnected ? GLOFOX_HINT : undefined}
              onChange={(e) => { setLead(e.target.value); setSaved(false) }}
              onKeyDown={(e) => onRuleKeyDown(e, () => setLead(storedRule.lead_min))}
              className="w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text disabled:opacity-40"
            />
            min before each class
          </label>
          <label className="inline-flex items-center gap-1 text-xs text-un1t-subtle">
            Off
            <input
              type="number"
              min={0}
              max={MAX_CLASS_LEAD_LAG_MIN}
              value={lag}
              disabled={!glofoxConnected}
              title={!glofoxConnected ? GLOFOX_HINT : undefined}
              onChange={(e) => { setLag(e.target.value); setSaved(false) }}
              onKeyDown={(e) => onRuleKeyDown(e, () => setLag(storedRule.lag_min))}
              className="w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text disabled:opacity-40"
            />
            min after it
          </label>
        </div>
      )}

      {mode === 'class' && !glofoxConnected && (
        <p className="text-xs text-amber-700">{GLOFOX_HINT}.</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="secondary" loading={busy} disabled={!dirty} onClick={save}>Save schedule</Button>
        {saved && !dirty && <span className="text-xs text-emerald-700">Saved</span>}
      </div>

      {error && (
        <p className="flex items-start gap-1 text-xs text-red-700" role="alert">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  )
}

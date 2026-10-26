// SHELLY-UI.6 — what runs this plug: nothing, fixed windows, or the class
// timetable. SHELLYGROUPS.6 — the same editor runs a GROUP: the caller hands
// in the row (`row`, or `device` for the device card) and an `onSave(patch)`
// pointed at its own PATCH route, and the editor never knows which it is.
//
// THE CLASS RULE TRAVELS WHOLE. The device PATCH parses class_rule with its
// defaults (ShellyClassRule), so a rule sent without `days` or `merge_gap_min`
// would silently put a Mon–Fri rule back to every day. Sending all four fields
// is right for the group PATCH too (it merges, and a full rule merges to
// itself). "Pick at least one day" is checked here as well as by the schema
// only so Save can stay dead instead of spending a round trip on a 400.
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
import {
  MAX_FIXED_WINDOWS, MAX_CLASS_LEAD_LAG_MIN, DEFAULT_LEAD_MIN, DEFAULT_LAG_MIN, DEFAULT_MERGE_GAP_MIN, ALL_DAYS,
} from '@/lib/shelly/schemas'
import { DAY_LABELS } from '@/lib/schedule/windows'
import WindowsEditor from './WindowsEditor'

const MODES = [
  { value: 'none', label: 'Never automatic', hint: 'Stays wherever you leave it.' },
  { value: 'fixed', label: 'Fixed hours', hint: 'On and off at set times on set days.' },
  { value: 'class', label: 'Follow classes', hint: 'On before each class and off after it.' },
]

export const NO_DAYS_MESSAGE = 'Pick at least one day'

// W1.M3a — source-neutral: the answer is the membership source, not Glofox.
const GLOFOX_HINT = 'Connect a membership source with a class schedule to use class-linked schedules'
// PROFILESPREAD.1a: the page could not READ the Glofox status (a failed by-id
// read). Class mode stays off, but the reason must not claim Glofox is not
// connected.
export const GLOFOX_UNKNOWN_HINT = "Couldn't check Glofox. Reload to try again."

const clampMin = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_CLASS_LEAD_LAG_MIN, Math.max(0, Math.trunc(n)))
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// Stored days, cleaned to what the engine reads: unique ISO weekdays in order.
// Absent or empty falls to every day, the schema's default.
function storedDays(rule) {
  const raw = Array.isArray(rule?.days) ? rule.days : []
  const clean = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
  return clean.length ? clean : [...ALL_DAYS]
}

export default function ShellyScheduleEditor({ row, device: deviceProp, glofoxConnected, glofoxUnknown = false, onSave }) {
  const device = row ?? deviceProp
  const classHint = glofoxUnknown ? GLOFOX_UNKNOWN_HINT : GLOFOX_HINT
  const [mode, setMode] = useState(device.schedule_mode || 'none')
  const [windows, setWindows] = useState(Array.isArray(device.fixed_windows) ? device.fixed_windows : [])
  const [lead, setLead] = useState(device.class_rule?.lead_min ?? DEFAULT_LEAD_MIN)
  const [lag, setLag] = useState(device.class_rule?.lag_min ?? DEFAULT_LAG_MIN)
  const [gap, setGap] = useState(device.class_rule?.merge_gap_min ?? DEFAULT_MERGE_GAP_MIN)
  const [days, setDays] = useState(() => storedDays(device.class_rule))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  // SHELLY-UI.9b — the PATCH route's `notice`, surfaced here the same way the
  // card's enable toggle surfaces it. Switching the mode to 'none' on an
  // enabled device stops the schedule managing the relay just as completely as
  // switching the schedule off does, and the relay STAYS where it was left
  // (plan.js rule 2). Without this the one control that can do that silently
  // said 'Saved' over a plug the operator now believes nothing is holding on.
  const [notice, setNotice] = useState(null)

  const storedWindows = Array.isArray(device.fixed_windows) ? device.fixed_windows : []
  const storedRule = {
    lead_min: device.class_rule?.lead_min ?? DEFAULT_LEAD_MIN,
    lag_min: device.class_rule?.lag_min ?? DEFAULT_LAG_MIN,
    merge_gap_min: device.class_rule?.merge_gap_min ?? DEFAULT_MERGE_GAP_MIN,
    days: storedDays(device.class_rule),
  }

  function buildPatch() {
    const patch = {}
    if (mode !== (device.schedule_mode || 'none')) patch.schedule_mode = mode
    // The windows only travel with a fixed schedule, and the rule only with a
    // class one — sending the other would write a field the operator was not
    // looking at.
    if (mode === 'fixed' && !sameJson(windows, storedWindows)) patch.fixed_windows = windows
    if (mode === 'class') {
      const rule = {
        lead_min: clampMin(lead),
        lag_min: clampMin(lag),
        merge_gap_min: clampMin(gap),
        days: [...days].sort((a, b) => a - b),
      }
      if (!sameJson(rule, storedRule)) patch.class_rule = rule
    }
    return patch
  }

  const patch = buildPatch()
  const noDays = mode === 'class' && days.length === 0
  const dirty = Object.keys(patch).length > 0
  const canSave = dirty && !noDays

  function toggleDay(n) {
    setDays((cur) => (cur.includes(n) ? cur.filter((d) => d !== n) : [...cur, n].sort((a, b) => a - b)))
    setSaved(false)
  }

  async function save() {
    if (!canSave) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setSaved(false)
    const res = await onSave(patch)
    setBusy(false)
    if (!res?.ok) {
      setError(res?.message || 'Could not save this schedule')
      return
    }
    setSaved(true)
    // Only present when the save actually abandoned a relay that is currently
    // on — see the route's DISABLE_NOTICE.
    if (res.json?.notice) setNotice(res.json.notice)
  }

  // Enter saves, Escape puts the field back to what is stored. A number field
  // that swallows Enter reads as broken, and a typo needs an undo that is not
  // "remember what it was".
  function onRuleKeyDown(e, reset) {
    if (e.key === 'Enter') { e.preventDefault(); if (canSave) save() }
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
              title={disabled ? classHint : m.hint}
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
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center gap-3">
            {[
              { label: 'On before each class', value: lead, set: setLead, stored: storedRule.lead_min },
              { label: 'Off after each class', value: lag, set: setLag, stored: storedRule.lag_min },
              { label: 'Keep on if the gap is under', value: gap, set: setGap, stored: storedRule.merge_gap_min },
            ].map((f) => (
              <label key={f.label} className="inline-flex items-center gap-1 text-xs text-un1t-subtle">
                {f.label}
                <input
                  type="number"
                  min={0}
                  max={MAX_CLASS_LEAD_LAG_MIN}
                  value={f.value}
                  aria-label={f.label}
                  disabled={!glofoxConnected}
                  title={!glofoxConnected ? classHint : undefined}
                  onChange={(e) => { f.set(e.target.value); setSaved(false) }}
                  onKeyDown={(e) => onRuleKeyDown(e, () => f.set(f.stored))}
                  className="w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text disabled:opacity-40"
                />
                min
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Class days">
            {DAY_LABELS.map((d) => {
              const on = days.includes(d.n)
              return (
                <button
                  key={d.n}
                  type="button"
                  aria-pressed={on}
                  disabled={!glofoxConnected}
                  onClick={() => toggleDay(d.n)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition disabled:opacity-40 ${
                    on ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'
                  }`}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
          {noDays && <p className="text-xs text-red-700" role="alert">{NO_DAYS_MESSAGE}</p>}
        </div>
      )}

      {mode === 'class' && !glofoxConnected && (
        <p className="text-xs text-amber-700">{glofoxUnknown ? GLOFOX_UNKNOWN_HINT : `${GLOFOX_HINT}.`}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="secondary" loading={busy} disabled={!canSave} onClick={save}>Save schedule</Button>
        {saved && !dirty && <span className="text-xs text-emerald-700">Saved</span>}
      </div>

      {notice && (
        <p className="flex items-start gap-1 text-xs text-amber-700" role="status">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {notice}
        </p>
      )}

      {error && (
        <p className="flex items-start gap-1 text-xs text-red-700" role="alert">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  )
}

// SHELLYGROUPS.6 — one Shelly group: what it is doing, ONE switch for every
// member, the members underneath, and the schedule that runs them.
//
// THE RULES THIS CARD TAKES FROM THE ROUTES (and from ShellyDeviceCard, whose
// header explains each one for a single plug):
//
//  1. `now` IS THE SERVER'S ANSWER. GET /api/shelly/groups resolves each
//     group's windows with the engine's own call, so the reason line only
//     words what `now` says. It never resolves a window itself, and when the
//     timetable could not be read (`windows_unread`) it says so instead of
//     inventing a time.
//
//  2. THE SWITCH'S AMBER "1 of 2 on" IS A DISPLAY STATE, NOT A THIRD COMMAND.
//     It is drawn only when 0 < on_count < member_count, from each member's
//     last reading (absent is not on). Pressing it from amber switches every
//     member ON: the operator is looking at lights that are partly off.
//
//  3. BRANCH ON PENDING BEFORE PAINTING THE NEW STATE. The toggle answers
//     `applied: 'all' | 'partial' | 'none'`; anything short of 'all' means
//     some relays have NOT moved (they are queued: the group override is
//     saved and the cron applies it). The route's `message` is shown first —
//     it is written against the exact failure, per member — and ours is the
//     fallback for a body that carried none. A 429 arrives with `pending`
//     and is read the same way.
//
//  4. DURATION PRESETS ONLY FOR A MANAGED GROUP (enabled and a schedule). On
//     an unmanaged group the planner never closes an expired override, so a
//     countdown would be a promise nobody keeps; "Until midnight" omits
//     `until` so the route computes midnight in the STUDIO's zone.
//
//  5. A SWITCHED-OFF GROUP IS "NEVER AUTOMATIC". The card has no separate
//     on/off for the schedule (Richard's approved look), so the editor is
//     handed the group as `schedule_mode: 'none'` whenever `enabled` is false,
//     and a save that picks a mode carries the matching `enabled`. Otherwise a
//     new group (created enabled:false) given fixed hours would show them and
//     never run them.

'use client'

import { useState } from 'react'
import { AlertCircle, Droplet, Fan, Lightbulb, Plug, Trash2, Tv } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { DEFAULT_TZ, instantToZonedParts, timeLabelIn } from '@shared/zoned-time'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'
import { overrideUntilLabel } from './ShellyDeviceCard'
import ShellyScheduleEditor from './ShellyScheduleEditor'
import ShellyGroupMembersEditor from './ShellyGroupMembersEditor'

const HOUR_MS = 60 * 60 * 1000

const ICONS = { bulb: Lightbulb, fan: Fan, tv: Tv, plug: Plug, droplet: Droplet }

const DURATIONS = [
  { value: 'midnight', label: 'Until midnight' },
  { value: '1', label: '1 hour' },
  { value: '3', label: '3 hours' },
]

// Fallbacks only — the route's `message` wins (rule 3).
const PENDING_FALLBACK = 'Saved. Some lights have not moved yet — they will follow as soon as they are back online.'
const AUTO_REASON_COPY = {
  disabled: 'This group has no schedule — pick fixed hours or follow classes first.',
  no_schedule: 'This group has no schedule — pick fixed hours or follow classes first.',
}

const isManaged = (g) => Boolean(g?.enabled) && g?.schedule_mode !== 'none'
const deviceLabel = (d) => d.name || `${d.model || 'Shelly'} · ${String(d.device_id || '').slice(-4)}`

/**
 * The switch's face: 'on' | 'off' | 'mixed' | 'empty'.
 * Mixed only when SOME but not all members read on (rule 2).
 */
export function groupSwitchState(now) {
  const count = Number(now?.member_count) || 0
  const on = Number(now?.on_count) || 0
  if (count <= 0) return 'empty'
  if (on <= 0) return 'off'
  if (on >= count) return 'on'
  return 'mixed'
}

// Today's fixed hours, by the STUDIO's weekday: "06:00–21:00", several joined
// with commas, or null when none of the windows runs today.
function fixedHoursToday(windows, tz, nowMs) {
  let weekday
  try {
    weekday = instantToZonedParts(nowMs, tz).weekday
  } catch {
    weekday = instantToZonedParts(nowMs, DEFAULT_TZ).weekday
  }
  const today = (Array.isArray(windows) ? windows : [])
    .filter((w) => Array.isArray(w?.days) && w.days.includes(weekday) && w.on && w.off)
    .sort((a, b) => String(a.on).localeCompare(String(b.on)))
  if (!today.length) return null
  return today.map((w) => `${w.on}–${w.off}`).join(', ')
}

const safeTime = (iso, tz) => {
  try {
    return timeLabelIn(iso, tz)
  } catch {
    return timeLabelIn(iso, DEFAULT_TZ)
  }
}

/**
 * The one-line reason under a group's name, from the server's `now`:
 *   "Follows classes · on until 19:10", "Fixed hours · 06:00–21:00",
 *   "1 of 2 on · manual until midnight", "Never automatic".
 *
 * @param {object} group  a GET /api/shelly/groups row (with `now`)
 * @param {string} tz     the LOCATION's IANA zone
 * @param {number} nowMs
 */
export function groupReasonLine(group, tz = DEFAULT_TZ, nowMs = Date.now()) {
  const now = group?.now || {}
  let reason
  if (now.mode === 'override') {
    if (!isManaged(group)) reason = 'Manual · stays until changed'
    else if (safeTime(now.until, tz) === '00:00') reason = 'Manual until midnight'
    else reason = `Manual until ${overrideUntilLabel(now.until, nowMs, tz)}`
  } else if (now.mode === 'none' || !isManaged(group)) {
    reason = 'Never automatic'
  } else if (group.schedule_mode === 'fixed') {
    reason = `Fixed hours · ${fixedHoursToday(group.fixed_windows, tz, nowMs) || 'off today'}`
  } else if (now.windows_unread) {
    reason = "Follows classes · couldn't read today's classes"
  } else if (now.mode === 'window' && now.until) {
    reason = `Follows classes · on until ${safeTime(now.until, tz)}`
  } else if (now.next_on) {
    reason = `Follows classes · next on at ${safeTime(now.next_on, tz)}`
  } else {
    reason = 'Follows classes · no more classes today'
  }
  if (groupSwitchState(now) !== 'mixed') return reason
  return `${now.on_count} of ${now.member_count} on · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
}

const SWITCH_FACE = {
  on: { text: 'On', cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/40', aria: 'true' },
  off: { text: 'Off', cls: 'bg-un1t-muted/10 text-un1t-subtle border-un1t-border', aria: 'false' },
  mixed: { text: null, cls: 'bg-amber-500/10 text-amber-700 border-amber-500/40', aria: 'mixed' },
  empty: { text: 'No devices', cls: 'bg-un1t-muted/10 text-un1t-subtle border-un1t-border', aria: 'false' },
}

function memberDot(state) {
  if (state?.online === false) return 'bg-un1t-border'
  if (state?.output === true) return 'bg-emerald-500'
  if (state?.output === false) return 'bg-un1t-muted'
  return 'bg-amber-500'
}

function MemberRow({ device }) {
  const state = device.last_state || {}
  const offline = state.online === false
  // SHELLYNOPOWER.1's rule: only an ONLINE reading with both absent means the
  // hardware meters nothing.
  const noPower = state.online === true && state.apower == null && state.aenergy_wh == null
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="inline-flex min-w-0 items-center gap-2 text-un1t-text">
        <span className={`h-2 w-2 shrink-0 rounded-full ${memberDot(state)}`} aria-hidden="true" />
        <span className="truncate">{deviceLabel(device)}</span>
      </span>
      {offline ? (
        <span className="shrink-0 rounded-full bg-un1t-muted/10 px-2 py-0.5 text-[11px] text-un1t-subtle">Offline</span>
      ) : (
        <span className="shrink-0 text-un1t-subtle">
          {typeof state.apower === 'number' ? `${Math.round(state.apower)} W` : noPower ? 'Doesn’t report power' : '—'}
        </span>
      )}
    </li>
  )
}

export default function ShellyGroupCard({
  group, devices = [], groups = [], connected, locationTz = DEFAULT_TZ, glofoxConnected, glofoxUnknown = false, onChanged,
}) {
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null) // { tone: 'ok'|'warn'|'error', text }
  const [duration, setDuration] = useState('midnight')
  const [editingMembers, setEditingMembers] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const nowMs = Date.now()
  const managed = isManaged(group)
  const face = groupSwitchState(group.now)
  const faceInfo = SWITCH_FACE[face]
  const switchText = face === 'mixed' ? `${group.now.on_count} of ${group.now.member_count} on` : faceInfo.text
  const Icon = ICONS[group.icon] || Lightbulb

  const byId = new Map(devices.map((d) => [d.id, d]))
  const members = (Array.isArray(group.device_ids) ? group.device_ids : []).map((id) => byId.get(id)).filter(Boolean)

  const controlsOff = connected === false
  const switchTitle = controlsOff ? 'Connect your Shelly account first' : face === 'empty' ? 'Add devices to this group first' : undefined

  async function toggle(next) {
    setBusy(next)
    setResult(null)
    const body = { state: next }
    if ((next === 'on' || next === 'off') && managed && duration !== 'midnight') {
      body.until = new Date(Date.now() + Number(duration) * HOUR_MS).toISOString()
    }
    const res = await fetchJson(`/api/shelly/groups/${group.id}/toggle`, jsonBody('POST', body))
    setBusy(null)

    if (res.json?.success === false || (!res.ok && !res.json?.pending)) {
      setResult({ tone: 'error', text: errorText(res.json, 'That did not work') })
      await onChanged?.()
      return
    }
    // Rule 3 — pending BEFORE anything that looks like the new state.
    const applied = res.json?.applied
    if (res.json?.pending || applied === 'partial' || applied === 'none') {
      setResult({ tone: 'warn', text: res.json?.message || PENDING_FALLBACK })
      await onChanged?.()
      return
    }
    if (next === 'auto') {
      const reason = res.json?.reason
      setResult({ tone: AUTO_REASON_COPY[reason] ? 'warn' : 'ok', text: AUTO_REASON_COPY[reason] || 'Back on schedule.' })
      await onChanged?.()
      return
    }
    const done = next === 'on' ? 'Switched on.' : 'Switched off.'
    setResult(res.json?.notice ? { tone: 'warn', text: `${done} ${res.json.notice}` } : { tone: 'ok', text: done })
    await onChanged?.()
  }

  // Rule 5: the editor's mode choice carries the group's `enabled` with it.
  async function saveSchedule(patch) {
    const body = { ...patch }
    if ('schedule_mode' in patch) {
      const wantEnabled = patch.schedule_mode !== 'none'
      if (wantEnabled !== Boolean(group.enabled)) body.enabled = wantEnabled
    }
    const res = await fetchJson(`/api/shelly/groups/${group.id}`, jsonBody('PATCH', body))
    if (!res.ok || res.json?.success === false) {
      return { ok: false, message: errorText(res.json, 'Could not save this group') }
    }
    await onChanged?.()
    return { ok: true, json: res.json }
  }

  async function remove() {
    setBusy('delete')
    setResult(null)
    const res = await fetchJson(`/api/shelly/groups/${group.id}`, { method: 'DELETE' })
    setBusy(null)
    setConfirmingDelete(false)
    // 404 means it is already gone — which is what the operator asked for.
    if (!res.ok && res.status !== 404) {
      setResult({ tone: 'error', text: errorText(res.json, 'Could not delete this group') })
      return
    }
    await onChanged?.()
  }

  const editorRow = { ...group, schedule_mode: group.enabled ? group.schedule_mode || 'none' : 'none' }

  const resultClass = result?.tone === 'error'
    ? 'text-red-700'
    : result?.tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'

  return (
    <Card padding="md" className="space-y-3">
      {/* ——— header: icon, name, reason, the ONE switch ———————————————— */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 rounded-md bg-un1t-muted/10 p-1.5 text-un1t-text">
            <Icon size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-un1t-text">{group.name}</p>
            <p className="mt-0.5 text-xs text-un1t-subtle" title={`Times shown in ${locationTz}`}>
              {groupReasonLine(group, locationTz, nowMs)}
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={faceInfo.aria}
          aria-label={`${group.name}: ${switchText}`}
          title={switchTitle}
          disabled={controlsOff || face === 'empty' || busy === 'on' || busy === 'off'}
          onClick={() => toggle(face === 'on' ? 'off' : 'on')}
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-60 ${faceInfo.cls}`}
        >
          {busy === 'on' || busy === 'off' ? 'Switching…' : switchText}
        </button>
      </div>

      {managed && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            aria-label="How long"
            disabled={controlsOff}
            className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text"
          >
            {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <Button size="sm" variant="ghost" disabled={controlsOff || face === 'empty'} loading={busy === 'auto'} onClick={() => toggle('auto')}>
            Back to schedule
          </Button>
        </div>
      )}

      {result && (
        <p className={`flex items-start gap-1 text-xs ${resultClass}`} role="status">
          {result.tone === 'error' && <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />}
          {result.text}
        </p>
      )}

      {/* ——— members ——————————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3 space-y-2">
        {members.length > 0 ? (
          <ul className="space-y-1.5" aria-label="Devices in this group">
            {members.map((d) => <MemberRow key={d.id} device={d} />)}
          </ul>
        ) : (
          <p className="text-xs text-un1t-subtle">No devices in this group yet.</p>
        )}
        {editingMembers ? (
          <ShellyGroupMembersEditor
            group={group}
            devices={devices}
            groups={groups}
            onCancel={() => setEditingMembers(false)}
            onSaved={async () => { setEditingMembers(false); await onChanged?.() }}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditingMembers(true)}>Edit devices</Button>
        )}
      </div>

      {/* ——— the schedule ————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3">
        <ShellyScheduleEditor row={editorRow} glofoxConnected={glofoxConnected} glofoxUnknown={glofoxUnknown} onSave={saveSchedule} />
      </div>

      {/* ——— delete ——————————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3">
        {!confirmingDelete ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmingDelete(true)}>Delete group</Button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-un1t-text">
              Delete this group? Its devices stay as they are, with no schedule, until you switch them or add them to another group.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="danger" loading={busy === 'delete'} onClick={remove}>Delete group</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>Keep it</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

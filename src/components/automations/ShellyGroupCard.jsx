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
//     saved and the cron applies it). When the answer names its
//     `pending_members` (SHELLYICONS.1) each one is worded by its own `code`,
//     by name, exactly as "Back to schedule" is (rule 6): offline → "will
//     follow when back online", permanent → "Shelly refused <name>",
//     unverified/bad_device → "couldn't confirm <name>". Otherwise the route's
//     `message` is shown, and ours is the fallback for a body with neither.
//     A 429 arrives with `pending` and is read the same way.
//
//  4. DURATION PRESETS ONLY FOR A MANAGED GROUP (enabled and a schedule). On
//     an unmanaged group the planner never closes an expired override, so a
//     countdown would be a promise nobody keeps; "Until midnight" omits
//     `until` so the route computes midnight in the STUDIO's zone.
//
//  6. "BACK TO SCHEDULE" IS WORDED FROM `results[]` (SHELLYGROUPS.8). The
//     'auto' branch sends no `message`, so each member that did not move is
//     read by its own `code`: 'occurrences' means the timetable could not be
//     read (nothing was sent, so "will follow when back online" would be a
//     promise about the wrong failure); a PERMANENT refusal names the device
//     and says Shelly refused it; only a member that did not answer is told it
//     will follow once it is back online.
//
//  7. THE RESULT LINE CLEARS ITSELF (the page's refresh-verdict rule): after
//     RESULT_MS, or, for a pending answer, on the first poll whose `now`
//     shows every member as asked. A verdict left on screen becomes a claim
//     about whatever the lights do next.
//
//  8. ONE ACTION AT A TIME. The switch, "Back to schedule" and Delete are all
//     locked while any of them is in flight: two of them racing would command
//     the same members twice in opposite directions.
//
//  9. THE SWITCH IS role="button" + aria-pressed, NOT role="switch".
//     aria-checked="mixed" is invalid on a switch; aria-pressed takes "mixed".
//     It keeps the switch's look.
//
// 10. THE ICON PICKER (SHELLYICONS.1) offers exactly SHELLY_GROUP_ICONS, the
//     mig 776 CHECK list, and PATCHes `{ icon }` alone. The chosen icon is
//     shown at once and kept until the next poll hands back the group with it;
//     a refused save leaves the old icon and says why.
//
//  5. A SWITCHED-OFF GROUP IS "NEVER AUTOMATIC". The card has no separate
//     on/off for the schedule (Richard's approved look), so the editor is
//     handed the group as `schedule_mode: 'none'` whenever `enabled` is false,
//     and a save that picks a mode carries the matching `enabled`. Otherwise a
//     new group (created enabled:false) given fixed hours would show them and
//     never run them.

'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Droplet, Fan, Lightbulb, Plug, Trash2, Tv } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { DEFAULT_TZ, instantToZonedParts, timeLabelIn } from '@shared/zoned-time'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'
import { MAX_GROUP_NAME, SHELLY_GROUP_ICONS } from '@/lib/shelly/schemas'
import { overrideUntilLabel } from './ShellyDeviceCard'
import ShellyScheduleEditor from './ShellyScheduleEditor'
import ShellyGroupMembersEditor from './ShellyGroupMembersEditor'

const HOUR_MS = 60 * 60 * 1000
// Long enough to read; short enough not to be read as the state of whatever
// happens next (ShellyDevicesClient's REFRESH_MSG_MS is the same idea).
export const RESULT_MS = 10_000

const ICONS = { bulb: Lightbulb, fan: Fan, tv: Tv, plug: Plug, droplet: Droplet }
const ICON_LABELS = { bulb: 'Bulb', fan: 'Fan', tv: 'TV', plug: 'Plug', droplet: 'Droplet' }

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

const NAME_TAKEN_COPY = 'A group with that name already exists'

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
    const hours = fixedHoursToday(group.fixed_windows, tz, nowMs)
    // An overnight window opened yesterday is not in today's list, but the
    // server says it is open: name its end rather than claim "off today".
    if (hours) reason = `Fixed hours · ${hours}`
    else if (now.mode === 'window' && now.until) reason = `Fixed hours · on until ${safeTime(now.until, tz)}`
    else reason = 'Fixed hours · off today'
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

const joinNames = (names) => (names.length <= 1
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

// Our copy for a member the route could not move, keyed by its `code` (the
// toggle route's PENDING_CODE vocabulary plus the auto branch's own codes).
const AUTO_CODE_COPY = {
  auth: 'Shelly rejected the stored key — re-paste it from the Shelly app.',
  rate_limited: 'Shelly is busy right now — the group will follow within a minute.',
  config: 'The Shelly server on file is invalid — fix it in the connection settings.',
}

// The sentences for the members that did not move, each by its own `code`:
// shared by "Back to schedule" (results[]) and the on/off press
// (pending_members[]), so the two never word the same failure differently.
function missedMemberParts(missed, nameOf) {
  const name = typeof nameOf === 'function' ? nameOf : () => 'a device'
  const parts = []
  const names = (rows) => joinNames(rows.map((r) => name(r.device_id)))

  const refused = missed.filter((r) => r.permanent === true)
  if (refused.length) {
    parts.push(`Shelly refused ${names(refused)} — check ${refused.length === 1 ? 'it' : 'them'} in the Shelly app.`)
  }
  const accountWide = new Set()
  for (const r of missed) if (!r.permanent && AUTO_CODE_COPY[r.code]) accountWide.add(AUTO_CODE_COPY[r.code])
  parts.push(...accountWide)

  const mismatch = missed.filter((r) => r.code === 'plan_mismatch')
  if (mismatch.length) parts.push(`${names(mismatch)} ${mismatch.length === 1 ? 'was' : 'were'} not switched.`)
  const unverified = missed.filter((r) => !r.permanent && (r.code === 'unverified' || r.code === 'bad_device'))
  if (unverified.length) parts.push(`Couldn't confirm ${names(unverified)}.`)

  const handled = new Set(['plan_mismatch', 'unverified', 'bad_device', ...Object.keys(AUTO_CODE_COPY)])
  const silent = missed.filter((r) => !r.permanent && !handled.has(r.code))
  if (silent.length) {
    const one = silent.length === 1
    parts.push(`${names(silent)} did not answer — ${one ? 'it' : 'they'} will follow when ${one ? 'it is' : 'they are'} back online.`)
  }
  return parts
}

/**
 * What "Back to schedule" did, from the route's `results[]` (rule 6).
 * Returns null when every member moved.
 *
 * @param {Array<{device_id: string, applied: string|null, code?: string, shelly_code?: string, permanent?: boolean}>} results
 * @param {(id: string) => string} nameOf
 */
export function autoOutcomeText(results, nameOf) {
  const missed = (Array.isArray(results) ? results : []).filter((r) => r && r.applied == null)
  if (!missed.length) return null
  if (missed.some((r) => r.code === 'occurrences')) {
    return "Couldn't read today's classes — nothing was switched. Try again in a minute."
  }
  const total = results.length
  const moved = total - missed.length
  const lead = moved > 0 ? `Back on schedule for ${moved} of ${total}.` : 'Nothing moved yet.'
  return `${lead} ${missedMemberParts(missed, nameOf).join(' ')}`
}

/**
 * What an on/off press did, from the route's `pending_members[]` (rule 3).
 * Returns null when the answer names no pending member (the caller then shows
 * the route's `message`).
 *
 * @param {Array<{device_id: string, code?: string, shelly_code?: string, permanent?: boolean}>} pendingMembers
 * @param {number} total   how many members the press was for
 * @param {'on'|'off'} state
 * @param {(id: string) => string} nameOf
 */
export function toggleOutcomeText(pendingMembers, total, state, nameOf) {
  const missed = (Array.isArray(pendingMembers) ? pendingMembers : []).filter((p) => p && p.device_id)
  if (!missed.length) return null
  const count = Math.max(Number(total) || 0, missed.length)
  const moved = count - missed.length
  const lead = moved > 0 ? `Switched ${state} for ${moved} of ${count}.` : 'Saved. Nothing has moved yet.'
  return `${lead} ${missedMemberParts(missed, nameOf).join(' ')}`
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
  // { tone: 'ok'|'warn'|'error', text, want?: 'on'|'off' } — `want` is set on a
  // pending on/off answer: a poll showing every member that way clears it.
  const [result, setResult] = useState(null)
  const [duration, setDuration] = useState('midnight')
  const [editingMembers, setEditingMembers] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(group.name || '')
  const [nameError, setNameError] = useState(null)
  // Rename has its own flag: it never blocks, or is blocked by, the switch.
  const [savingName, setSavingName] = useState(false)
  // Rule 10: the picker, and the icon just saved until the poll catches up.
  const [pickingIcon, setPickingIcon] = useState(false)
  const [savedIcon, setSavedIcon] = useState(null)
  const [savingIcon, setSavingIcon] = useState(false)

  const nowMs = Date.now()
  const managed = isManaged(group)
  const face = groupSwitchState(group.now)
  const faceInfo = SWITCH_FACE[face]
  const switchText = face === 'mixed' ? `${group.now.on_count} of ${group.now.member_count} on` : faceInfo.text
  const iconKey = ICONS[savedIcon] ? savedIcon : ICONS[group.icon] ? group.icon : 'bulb'
  const Icon = ICONS[iconKey]

  const byId = new Map(devices.map((d) => [d.id, d]))
  const members = (Array.isArray(group.device_ids) ? group.device_ids : []).map((id) => byId.get(id)).filter(Boolean)

  // Rule 7: self-clearing.
  useEffect(() => {
    if (!result) return undefined
    const t = setTimeout(() => setResult(null), RESULT_MS)
    return () => clearTimeout(t)
  }, [result])
  useEffect(() => {
    if (result?.want && face === result.want) setResult(null)
  }, [face, result])
  // The poll's answer replaces the locally-saved icon once it carries one.
  useEffect(() => { setSavedIcon(null) }, [group.icon])

  const controlsOff = connected === false
  const anyBusy = busy !== null
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
      const nameOf = (id) => {
        const d = byId.get(id)
        return d ? deviceLabel(d) : 'a device'
      }
      const base = (next === 'auto'
        ? res.json?.message || autoOutcomeText(res.json?.results, nameOf)
        : toggleOutcomeText(res.json?.pending_members, members.length || group.now?.member_count, next, nameOf) || res.json?.message)
        || PENDING_FALLBACK
      // An unmanaged group's lights stay as set: said on a partial answer too.
      const notice = res.json?.notice
      setResult({ tone: 'warn', text: notice ? `${base} ${notice}` : base, want: next === 'on' || next === 'off' ? next : undefined })
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

  async function pickIcon(icon) {
    setPickingIcon(false)
    if (savingIcon || icon === iconKey) return
    setSavingIcon(true)
    const res = await fetchJson(`/api/shelly/groups/${group.id}`, jsonBody('PATCH', { icon }))
    setSavingIcon(false)
    if (!res.ok || res.json?.success === false) {
      setResult({ tone: 'error', text: errorText(res.json, 'Could not change the icon') })
      return
    }
    setSavedIcon(icon)
    await onChanged?.()
  }

  function cancelRename() {
    setRenaming(false)
    setNameError(null)
    setNameDraft(group.name || '')
  }

  async function saveName() {
    if (savingName) return
    const trimmed = nameDraft.trim()
    if (!trimmed) {
      setNameError('Give the group a name')
      return
    }
    if (trimmed === group.name) {
      cancelRename()
      return
    }
    setSavingName(true)
    setNameError(null)
    const res = await fetchJson(`/api/shelly/groups/${group.id}`, jsonBody('PATCH', { name: trimmed }))
    setSavingName(false)
    if (!res.ok || res.json?.success === false) {
      setNameError(res.json?.code === 'name_taken' ? NAME_TAKEN_COPY : errorText(res.json, 'Could not rename this group'))
      return
    }
    setRenaming(false)
    await onChanged?.()
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
          <button
            type="button"
            onClick={() => setPickingIcon((v) => !v)}
            disabled={savingIcon}
            aria-expanded={pickingIcon ? 'true' : 'false'}
            aria-label={`Change icon, now ${ICON_LABELS[iconKey]}`}
            title="Change icon"
            className="mt-0.5 shrink-0 rounded-md bg-un1t-muted/10 p-1.5 text-un1t-text hover:bg-un1t-muted/20 disabled:opacity-60"
          >
            <Icon size={16} aria-hidden="true" />
          </button>
          <div className="min-w-0">
            {renaming ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={nameDraft}
                    maxLength={MAX_GROUP_NAME}
                    autoFocus
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); if (!savingName) saveName() }
                      if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    aria-label="Group name"
                    className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
                  />
                  <Button size="sm" variant="secondary" loading={savingName} onClick={saveName} aria-label="Save name">Save</Button>
                  <Button size="sm" variant="ghost" onClick={cancelRename}>Cancel</Button>
                </div>
                {nameError && <p className="text-xs text-red-700" role="alert">{nameError}</p>}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setNameDraft(group.name || ''); setNameError(null); setRenaming(true) }}
                className="block max-w-full truncate text-left text-sm font-semibold text-un1t-text hover:underline"
                aria-label={`Rename ${group.name}`}
                title="Rename"
              >
                {group.name}
              </button>
            )}
            <p className="mt-0.5 text-xs text-un1t-subtle" title={`Times shown in ${locationTz}`}>
              {groupReasonLine(group, locationTz, nowMs)}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-pressed={faceInfo.aria}
          aria-label={`${group.name}: ${switchText}`}
          title={switchTitle}
          // One action at a time: a press while "Back to schedule" or a delete
          // is in flight would race it on the same members.
          disabled={controlsOff || face === 'empty' || anyBusy}
          onClick={() => toggle(face === 'on' ? 'off' : 'on')}
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-60 ${faceInfo.cls}`}
        >
          {busy === 'on' || busy === 'off' ? 'Switching…' : switchText}
        </button>
      </div>

      {pickingIcon && (
        <div role="group" aria-label="Group icon" className="flex flex-wrap items-center gap-1">
          {SHELLY_GROUP_ICONS.map((key) => {
            const Glyph = ICONS[key]
            const current = key === iconKey
            return (
              <button
                key={key}
                type="button"
                aria-label={ICON_LABELS[key]}
                aria-pressed={current ? 'true' : 'false'}
                title={ICON_LABELS[key]}
                onClick={() => pickIcon(key)}
                className={`rounded-md border p-1.5 ${current
                  ? 'border-un1t-accent bg-un1t-accent/10 text-un1t-text'
                  : 'border-un1t-border text-un1t-subtle hover:bg-un1t-muted/10 hover:text-un1t-text'}`}
              >
                <Glyph size={16} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}

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
          <Button size="sm" variant="ghost" disabled={controlsOff || face === 'empty' || anyBusy} loading={busy === 'auto'} onClick={() => toggle('auto')}>
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
          <Button size="sm" variant="ghost" icon={Trash2} disabled={anyBusy} onClick={() => setConfirmingDelete(true)}>Delete group</Button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-un1t-text">
              Delete this group? Its devices stay as they are, with no schedule, until you switch them or add them to another group.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="danger" disabled={anyBusy} loading={busy === 'delete'} onClick={remove}>Delete group</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>Keep it</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

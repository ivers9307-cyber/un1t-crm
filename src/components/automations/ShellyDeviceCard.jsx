// SHELLY-UI.6 — one adopted relay: what it is doing, what runs it, and how to
// take it off its schedule for a while.
//
// FOUR RENDER RULES THE SHIPPED ROUTES DEPEND ON. Each was a review finding on
// the backend, and each is a lie waiting to happen if this file paraphrases it:
//
//  1. `last_state.output === null` IS "UNKNOWN", NEVER "OFF". An offline plug
//     reports nothing about its relay, and mig 562's column comment makes every
//     writer write the full seven-field shape precisely so the null survives.
//     Printing "Off" for it tells an operator a heater is safe when nobody
//     knows whether it is.
//
//  2. BRANCH ON `pending` BEFORE PAINTING THE NEW STATE. A toggle answers
//     `{ success: true, applied: false, pending: true }` when the override is
//     saved and the relay has NOT moved — the cron will apply it. Painting the
//     requested state there would show a plug as ON while it is physically off.
//     (That body arrives with HTTP 200, and with 429 for a rate limit — the
//     rate limit is a back-off signal, not a failure, so both are read the
//     same way.)
//
//  3. THE DURATION PRESETS ARE FOR MANAGED DEVICES ONLY. On a device that is
//     `enabled` AND has a schedule, `until` is a real expiry: plan.js rule 3
//     re-opens the relay at it if a window is live and rule 4 closes it
//     otherwise. On an UNMANAGED device (`enabled:false` or
//     `schedule_mode:'none'`) rule 2 returns before rule 4, so an expired
//     override is never undone and the relay STAYS AS SET. Those responses
//     carry `holds_until_changed: true`, and a countdown rendered next to one
//     would be a promise the engine never intended to keep.
//
//  4. `auto` ANSWERS THREE REASONS, not two: 'disabled' (the schedule is off),
//     'no_schedule' (there is nothing to go back to) and 'nothing_to_do'
//     (already correct). They call for three different actions from the
//     operator, so they get three different sentences.
//
// Two destructive-ish actions are two-step: Remove (the energy history goes
// with the row — ON DELETE CASCADE, mig 562) and, on the connection panel,
// Disconnect.

'use client'

import { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Play, Trash2 } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { formatRelative } from '@/lib/dates'
import { deviceHealth, HEALTH_TONE_CLASSES } from '@/lib/shelly/device-health'
// The ENGINE's own answer to "is this override live", not a second copy of the
// same comparison — a planner that stopped honouring an override and a card
// that kept showing the banner would disagree silently.
import { isLiveOverride } from '@/lib/shelly/plan'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'
import ShellyScheduleEditor from './ShellyScheduleEditor'
import ShellyEnergyChart from './ShellyEnergyChart'

const HOUR_MS = 60 * 60 * 1000

// What the toggle's `code` means for someone standing in front of the plug.
// Keyed by OUR vocabulary (the route maps the client's `kind` onto it), and
// every entry starts with "Queued" because that is the fact: the override is
// saved and the cron will apply it.
const PENDING_COPY = {
  pending: 'Queued — the plug will follow when it is back online.',
  key_rejected: 'Queued — re-paste the Shelly key above and the plug will follow.',
  rate_limited: 'Queued — Shelly is busy right now; the plug will follow within a minute.',
  bad_host: 'Queued — fix the Shelly server in the connection settings and the plug will follow.',
}

// `auto`'s three noops. Run-now keeps the same three apart one route over.
const AUTO_REASON_COPY = {
  disabled: 'Schedule is switched off — turn it on first.',
  no_schedule: 'No schedule to return to.',
  nothing_to_do: 'Already on schedule.',
}

const UNMANAGED_HINT = 'No schedule runs this plug — it stays as you set it until you change it.'

const DURATIONS = [
  { value: 'midnight', label: 'Until midnight' },
  { value: '1', label: '1 hour' },
  { value: '3', label: '3 hours' },
]

// Composed at render time, never stored: adopt writes `name` as the operator's
// choice, then the Shelly account's, then NULL. A synthesised name on the row
// would be indistinguishable from a human's the moment anyone looked at it.
const placeholderName = (device) => `${device.model || 'Shelly'} · ${String(device.device_id || '').slice(-4)}`

// The relay, as a word. The tri-state is the whole point — see rule 1.
function outputLabel(output) {
  if (output === true) return 'On'
  if (output === false) return 'Off'
  return 'Unknown'
}

// Local time, and said so in the title: the override's real expiry is the
// LOCATION's midnight (the route computes it in the location's zone), and an
// operator abroad would otherwise read the browser's rendering as the studio's.
function untilLabel(iso) {
  const ms = Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function ShellyDeviceCard({ device, connected, glofoxConnected, onChanged }) {
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(device.name || '')
  // WHICH action is in flight, not merely "an action is". A boolean would put
  // a spinner on every button on the card at once, so the operator cannot see
  // what they pressed.
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null) // { tone: 'ok'|'warn'|'error', text }
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [duration, setDuration] = useState('midnight')
  const [showEnergy, setShowEnergy] = useState(false)

  const nowMs = Date.now()
  const health = deviceHealth(device, { connected, nowMs })
  const managed = Boolean(device.enabled) && device.schedule_mode !== 'none'
  const state = device.last_state || {}
  const overrideLive = isLiveOverride(device.override, nowMs)
  // The toggle strip is dead when there is no connection to send through, or
  // when the device itself told us it is unreachable.
  const controlsOff = connected === false || health.reason === 'offline'

  async function patch(body) {
    const res = await fetchJson(`/api/shelly/devices/${device.id}`, jsonBody('PATCH', body))
    if (!res.ok || res.json?.success === false) {
      return { ok: false, message: errorText(res.json, 'Could not save this device') }
    }
    await onChanged?.()
    return { ok: true, json: res.json }
  }

  async function saveName() {
    setBusy('name')
    setResult(null)
    const trimmed = nameDraft.trim()
    const out = await patch({ name: trimmed })
    setBusy(null)
    if (!out.ok) {
      setResult({ tone: 'error', text: out.message })
      return
    }
    setRenaming(false)
  }

  async function toggle(next) {
    setBusy(next)
    setResult(null)
    const body = { state: next }
    // Only the hour presets carry an `until`. "Until midnight" is deliberately
    // OMITTED so the route computes it in the LOCATION's zone rather than in
    // the browser's — a studio abroad would otherwise expire at ours.
    if ((next === 'on' || next === 'off') && duration !== 'midnight') {
      body.until = new Date(Date.now() + Number(duration) * HOUR_MS).toISOString()
    }
    const res = await fetchJson(`/api/shelly/devices/${device.id}/toggle`, jsonBody('POST', body))
    setBusy(null)

    // A failure body (including `auto`'s) folds its reassurance into `error`.
    if (res.json?.success === false || (!res.ok && !res.json?.pending)) {
      setResult({ tone: 'error', text: errorText(res.json, 'That did not work') })
      await onChanged?.()
      return
    }
    // Rule 2 — pending BEFORE anything that looks like the new state.
    if (res.json?.pending) {
      const code = res.json.code || 'pending'
      setResult({ tone: 'warn', text: PENDING_COPY[code] || res.json.message || PENDING_COPY.pending })
      await onChanged?.()
      return
    }
    if (next === 'auto') {
      const reason = res.json?.reason
      setResult({
        tone: 'ok',
        text: AUTO_REASON_COPY[reason]
          || (res.json?.applied ? `Back on schedule — switched ${res.json.applied}.` : 'Back on schedule.'),
      })
      await onChanged?.()
      return
    }
    setResult({ tone: 'ok', text: next === 'on' ? 'Switched on.' : 'Switched off.' })
    await onChanged?.()
  }

  async function setEnabled(nextEnabled) {
    setBusy('enabled')
    setResult(null)
    const out = await patch({ enabled: nextEnabled })
    setBusy(null)
    if (!out.ok) {
      setResult({ tone: 'error', text: out.message })
      return
    }
    // The route only sends `notice` when switching the schedule off actually
    // leaves the relay on — it is the sentence that stops an operator walking
    // away from a plug they believe they just turned off.
    if (out.json?.notice) setResult({ tone: 'warn', text: out.json.notice })
  }

  async function runNow() {
    setBusy('run')
    setResult(null)
    const res = await fetchJson(`/api/shelly/devices/${device.id}/run-now`, { method: 'POST' })
    setBusy(null)
    if (!res.ok || res.json?.success === false) {
      setResult({ tone: 'error', text: errorText(res.json, 'Could not apply the schedule') })
      await onChanged?.()
      return
    }
    setResult({
      tone: 'ok',
      text: res.json?.applied ? `Applied — switched ${res.json.applied}.` : 'Already matching its schedule.',
    })
    await onChanged?.()
  }

  async function remove() {
    setBusy('remove')
    setResult(null)
    const res = await fetchJson(`/api/shelly/devices/${device.id}`, { method: 'DELETE' })
    setBusy(null)
    setConfirmingRemove(false)
    // 404 means it is already gone — which is what the operator asked for.
    if (!res.ok && res.status !== 404) {
      setResult({ tone: 'error', text: errorText(res.json, 'Could not remove this device') })
      return
    }
    await onChanged?.()
  }

  const canEnable =
    (device.schedule_mode === 'fixed' && (device.fixed_windows?.length || 0) > 0)
    || (device.schedule_mode === 'class' && glofoxConnected)

  const resultClass = result?.tone === 'error'
    ? 'text-red-700'
    : result?.tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'

  return (
    <Card padding="md" className="space-y-3">
      {/* ——— header ——————————————————————————————————————————————— */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={nameDraft}
                maxLength={80}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={placeholderName(device)}
                aria-label="Device name"
                className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
              />
              <Button size="sm" variant="secondary" loading={busy === 'name'} onClick={saveName}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenaming(false); setNameDraft(device.name || '') }}>
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setNameDraft(device.name || ''); setRenaming(true) }}
              className="truncate text-left text-sm font-semibold text-un1t-text hover:underline"
              title="Rename"
            >
              {device.name || placeholderName(device)}
            </button>
          )}
          <p className="mt-0.5 text-xs text-un1t-subtle">
            {device.model || 'Shelly'}
            {device.gen ? ` · Gen ${device.gen}` : ''}
            {device.channel > 0 ? (
              <span className="ml-2 rounded-full bg-un1t-muted/10 px-2 py-0.5 text-[11px] text-un1t-subtle">
                Channel {device.channel}
              </span>
            ) : null}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${HEALTH_TONE_CLASSES[health.tone]}`}>
          {health.label}
        </span>
      </div>

      {/* ——— what it is doing ————————————————————————————————————— */}
      <p className="text-xs text-un1t-subtle">
        <span className="font-medium text-un1t-text">{outputLabel(state.output)}</span>
        {' · '}
        {typeof state.apower === 'number' ? `${Math.round(state.apower)} W` : '—'}
        {state.at ? ` · ${formatRelative(state.at)}` : ''}
      </p>

      {overrideLive && (
        <p className="text-xs text-amber-700">
          {device.override.state === 'on' ? 'Forced ON' : 'Forced OFF'}
          {/* Rule 3: an unmanaged device's `until` bounds nothing the engine
              will act on, so no time is shown for one. */}
          {managed
            ? ` until ${untilLabel(device.override.until)} — set ${formatRelative(device.override.set_at)}`
            : ' — stays until changed'}
        </p>
      )}

      {/* ——— the manual switch ————————————————————————————————————— */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={controlsOff} loading={busy === 'on'} onClick={() => toggle('on')}>On</Button>
        <Button size="sm" variant="secondary" disabled={controlsOff} loading={busy === 'off'} onClick={() => toggle('off')}>Off</Button>
        {managed && (
          <>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              aria-label="How long"
              disabled={controlsOff}
              className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-xs text-un1t-text"
            >
              {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <Button size="sm" variant="ghost" disabled={controlsOff} loading={busy === 'auto'} onClick={() => toggle('auto')}>
              Back to schedule
            </Button>
          </>
        )}
      </div>
      {!managed && <p className="text-xs text-un1t-subtle">{UNMANAGED_HINT}</p>}

      {result && (
        <p className={`flex items-start gap-1 text-xs ${resultClass}`} role="status">
          {result.tone === 'error' && <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />}
          {result.text}
        </p>
      )}

      {/* ——— the schedule ————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            className="inline-flex items-center gap-1.5 text-xs text-un1t-text"
            title={canEnable ? undefined : 'Add a window (or connect Glofox for class mode) first'}
          >
            <input
              type="checkbox"
              checked={Boolean(device.enabled)}
              // Only the ENABLE direction needs a schedule to enable; turning
              // one off must never be blocked by the state it is in.
              disabled={busy === 'enabled' || (!device.enabled && !canEnable)}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Schedule on
          </label>
          <Button
            size="sm"
            variant="ghost"
            icon={Play}
            loading={busy === 'run'}
            disabled={!device.enabled || device.schedule_mode === 'none' || connected !== true}
            onClick={runNow}
          >
            Run now
          </Button>
        </div>
        <div className="mt-2">
          <ShellyScheduleEditor device={device} glofoxConnected={glofoxConnected} onSave={patch} />
        </div>
      </div>

      {/* ——— energy ——————————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3">
        <button
          type="button"
          onClick={() => setShowEnergy((v) => !v)}
          aria-expanded={showEnergy}
          className="inline-flex items-center gap-1 text-xs font-medium text-un1t-text"
        >
          {showEnergy ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          Energy
        </button>
        {/* Mounted only when open — the fetch lives in the chart, so a page of
            ten devices costs zero energy queries until someone asks. */}
        {showEnergy && <div className="mt-2"><ShellyEnergyChart deviceId={device.id} /></div>}
      </div>

      {/* ——— remove ——————————————————————————————————————————————— */}
      <div className="border-t border-un1t-border/60 pt-3">
        {/* "Remove plug", not "Remove": the window editor above renders its
            own per-window Remove, and two controls a screen reader announces
            identically is how the wrong one gets pressed. */}
        {!confirmingRemove ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmingRemove(true)}>Remove plug</Button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-un1t-text">
              Remove this plug? Its energy history is deleted with it. To move a plug to another studio, remove it here
              and adopt it there.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="danger" loading={busy === 'remove'} onClick={remove}>Remove plug</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>Keep it</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

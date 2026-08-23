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

import { useEffect, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Play, Trash2 } from 'lucide-react'
import { Button, Card } from '@/components/ui'
import { formatRelative } from '@/lib/dates'
import { addDaysISO } from '@/lib/dublin-time'
import { dayStrInTz, DEFAULT_TZ } from '@/lib/tz-time'
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

// An offline plug is still SETTABLE. The toggle route writes the override
// BEFORE it sends anything, and the cron applies a live override to every
// adopted device, enabled or not — so pressing On here is a real instruction
// that lands when the plug wakes up, not a no-op. Disabling the buttons would
// throw away the one path the backend built for exactly this case.
const OFFLINE_TITLE = 'Offline — your choice is queued and applied when the plug is back'

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

/**
 * When an override ends, IN THE STUDIO'S OWN ZONE.
 *
 * The route computes the default expiry as the LOCATION's next local midnight
 * (nextLocalMidnightMs against the location's timezone), so rendering it in
 * the browser's zone would print a number that is simply not the one the
 * engine will act on — "until 00:00" for a New York studio read from Dublin
 * is 19:00 there, five hours early, and nothing on screen would say so.
 *
 * The DAY is carried too whenever it is not today's: "until midnight" is
 * almost always tomorrow by the studio's clock, and a bare "00:00" reads as a
 * time that has already passed.
 *
 * @param {string} iso    the override's `until`
 * @param {number} nowMs  testable clock
 * @param {string} tz     the LOCATION's IANA zone
 */
export function overrideUntilLabel(iso, nowMs, tz = DEFAULT_TZ) {
  const ms = Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return ''
  let time
  try {
    time = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(ms)
  } catch {
    // An unusable zone must cost the DAY QUALIFIER, not the whole banner —
    // the operator still needs to know an override is holding the relay.
    return new Date(ms).toISOString().slice(11, 16)
  }
  const today = dayStrInTz(nowMs, tz)
  const day = dayStrInTz(ms, tz)
  if (day === today) return time
  if (day === addDaysISO(today, 1)) return `${time} tomorrow`
  const weekday = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short' }).format(ms)
  return `${weekday} ${time}`
}

export default function ShellyDeviceCard({ device, connected, locationTz = DEFAULT_TZ, glofoxConnected, onChanged }) {
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
  // The toggle route's own verdict on whether this override will ever be
  // closed. Authoritative for the window between the response and the reload
  // that follows it (another tab may have changed `enabled` underneath us);
  // cleared the moment a fresh row lands, because the row is then the answer.
  const [respHolds, setRespHolds] = useState(null)

  useEffect(() => { setRespHolds(null) }, [device.updated_at])

  const nowMs = Date.now()
  const health = deviceHealth(device, { connected, nowMs })
  const managed = Boolean(device.enabled) && device.schedule_mode !== 'none'
  const state = device.last_state || {}
  // The route's answer when we have one, our own predicate otherwise. They
  // agree by construction (both read `enabled` and `schedule_mode`), so this
  // only matters in the window where the row on screen is older than the
  // response that just came back.
  const holdsUntilChanged = typeof respHolds === 'boolean' ? respHolds : !managed
  // AN UNMANAGED OVERRIDE HAS NO EXPIRY, so it must not vanish at `until`.
  // plan.js rule 2 returns before rule 4 can close anything, which means the
  // relay is STILL being held long after the timestamp passes — a banner that
  // disappeared then would leave a plug forced on with nothing on screen
  // saying so. For a managed device `until` is real and isLiveOverride (the
  // planner's own comparison) is exactly the right question.
  const overrideLive = holdsUntilChanged
    ? device.override?.state === 'on' || device.override?.state === 'off'
    : isLiveOverride(device.override, nowMs)
  // Only a missing CONNECTION kills the toggle strip. An offline plug is
  // still settable — see OFFLINE_TITLE.
  const controlsOff = connected === false
  const offline = health.reason === 'offline'
  const toggleTitle = controlsOff
    ? 'Connect your Shelly account first'
    : offline ? OFFLINE_TITLE : undefined

  async function patch(body) {
    const res = await fetchJson(`/api/shelly/devices/${device.id}`, jsonBody('PATCH', body))
    if (!res.ok || res.json?.success === false) {
      return { ok: false, message: errorText(res.json, 'Could not save this device') }
    }
    await onChanged?.()
    return { ok: true, json: res.json }
  }

  function cancelRename() {
    setRenaming(false)
    setNameDraft(device.name || '')
  }

  async function saveName() {
    const trimmed = nameDraft.trim()
    // ShellyDevicePatch requires a name of 1..80, so an empty one is a
    // guaranteed 400 — answered here, in the same words, rather than spent as
    // a round trip. (Clearing a name is not a thing the API offers.)
    if (!trimmed) {
      setResult({ tone: 'error', text: 'Give the device a name' })
      return
    }
    // Nothing to write. A no-op PATCH would still bump updated_at and pull the
    // whole list down again.
    if (trimmed === (device.name || '')) {
      setRenaming(false)
      return
    }
    setBusy('name')
    setResult(null)
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
    // Always present on a toggle answer (success and pending alike), and
    // absent on `auto` — hence the typeof guard rather than a truthiness one.
    if (typeof res.json?.holds_until_changed === 'boolean') setRespHolds(res.json.holds_until_changed)

    // A failure body (including `auto`'s) folds its reassurance into `error`.
    if (res.json?.success === false || (!res.ok && !res.json?.pending)) {
      setResult({ tone: 'error', text: errorText(res.json, 'That did not work') })
      await onChanged?.()
      return
    }
    // Rule 2 — pending BEFORE anything that looks like the new state.
    if (res.json?.pending) {
      const code = res.json.code || 'pending'
      // The ROUTE'S sentence first: it is written against the exact failure it
      // saw, and preferring our copy over it would mean maintaining a second
      // vocabulary for the same `kind` map. Ours is the fallback for a body
      // that carried no message.
      setResult({ tone: 'warn', text: res.json.message || PENDING_COPY[code] || PENDING_COPY.pending })
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

  const runNowTitle = connected === false
    ? 'Connect your Shelly account first'
    : device.schedule_mode === 'none' ? 'This plug has no schedule to apply'
      : !device.enabled ? 'Turn the schedule on first' : undefined

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
                // A one-field inline editor that ignores Enter reads as
                // broken; Escape is the way out that does not need the mouse.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); saveName() }
                  if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                }}
                placeholder={placeholderName(device)}
                aria-label="Device name"
                className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
              />
              <Button size="sm" variant="secondary" loading={busy === 'name'} onClick={saveName}>Save</Button>
              <Button size="sm" variant="ghost" onClick={cancelRename}>Cancel</Button>
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
        <p
          className="text-xs text-amber-700"
          // Named, not implied: the number is the STUDIO's clock, which is
          // only the reader's clock by coincidence.
          title={holdsUntilChanged ? undefined : `Times shown in ${locationTz}`}
        >
          {device.override.state === 'on' ? 'Forced ON' : 'Forced OFF'}
          {/* Rule 3: an unmanaged device's `until` bounds nothing the engine
              will act on, so no time is shown for one. */}
          {holdsUntilChanged
            ? ' — stays until changed'
            : ` until ${overrideUntilLabel(device.override.until, nowMs, locationTz)}`
              + ` — set ${formatRelative(device.override.set_at)}`}
        </p>
      )}

      {/* ——— the manual switch ————————————————————————————————————— */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" title={toggleTitle} disabled={controlsOff} loading={busy === 'on'} onClick={() => toggle('on')}>On</Button>
        <Button size="sm" variant="secondary" title={toggleTitle} disabled={controlsOff} loading={busy === 'off'} onClick={() => toggle('off')}>Off</Button>
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
            // `connected === false`, NOT `!== true`: an UNKNOWN connection is
            // our read failing, not the studio's, and the whole point of that
            // third state is that it disables nothing. If it turns out there
            // really is no connection, run-now answers its own 409
            // `not_connected` with copy the operator can act on.
            disabled={!device.enabled || device.schedule_mode === 'none' || connected === false}
            title={runNowTitle}
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

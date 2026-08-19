'use client'

// TAPO-T1.5 — the devices surface: adopt bridge-reported devices,
// configure each one's schedule (none | fixed windows | class-linked),
// and manually toggle on/off with an override that reverts to schedule.
//
// All data comes from /api/tapo/devices (GET) + /api/tapo/devices/[id]
// (PATCH config) + /api/tapo/devices/[id]/toggle (POST override). We
// refresh() after every mutation so the row reflects server truth
// (override/last_state/last_seen come back on each write). Styling
// mirrors ClassClimateCard: un1t-surface cards, un1t-bg inputs, chips
// as `bg-<c>-500/10 text-<c>-700`.

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Plug, Plus, X } from 'lucide-react'

// Staleness thresholds — a device that hasn't checked in recently
// can't be trusted to reflect its real state, so the dot warns.
const STALE_AMBER_MS = 5 * 60 * 1000
const STALE_RED_MS = 30 * 60 * 1000

const DAY_LABELS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 7, label: 'Sun' },
]

function fmtDublin(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return iso }
}

// For the "Manual until …" chip (Dublin wall-clock). The toggle
// route's DEFAULT expiry is the upcoming Dublin midnight, which a
// bare "00:00" renders ambiguously ("tonight or tomorrow night?") —
// so an exactly-midnight until reads "midnight"; anything else keeps
// its HH:MM.
function fmtOverrideUntil(iso) {
  if (!iso) return ''
  try {
    const hhmm = new Date(iso).toLocaleString('en-IE', {
      timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    return hhmm === '00:00' ? 'midnight' : hhmm
  } catch { return iso }
}

// green (on) / gray (off), overridden by amber (>5min) / red (>30min)
// staleness. Staleness takes precedence. Recomputed on every render
// (the parent's 60s tick keeps that honest over time). A device the
// bridge has NEVER reported gets the red dot too, but says so — "no
// contact for 30 min" would imply it was seen and went quiet.
function stateDot(device) {
  const last = device.last_seen_at ? Date.parse(device.last_seen_at) : null
  if (last == null || !Number.isFinite(last)) {
    return { cls: 'bg-red-500', title: 'Never reported' }
  }
  const age = Date.now() - last
  if (age > STALE_RED_MS) {
    return { cls: 'bg-red-500', title: 'No contact for over 30 min' }
  }
  if (age > STALE_AMBER_MS) {
    return { cls: 'bg-amber-500', title: 'No contact for over 5 min' }
  }
  if (device.last_state === 'on') return { cls: 'bg-emerald-500', title: 'On' }
  return { cls: 'bg-un1t-muted', title: 'Off' }
}

function overrideActive(override) {
  if (!override || !override.until) return false
  const ms = Date.parse(override.until)
  return Number.isFinite(ms) && ms > Date.now()
}

// A Zod-rejected mutation comes back as { error: 'Invalid request
// body', issues: [{ path, message }] } (src/lib/validate.js) — the
// bare error tells an operator nothing about WHICH field. Surface the
// first issue's message, naming the window ("Window 1: …") when the
// path points into fixed_windows.N. Falls back to j.error, then the
// caller's default.
function apiErrorMessage(j, fallback) {
  if (Array.isArray(j?.issues) && j.issues.length > 0) {
    const { path, message } = j.issues[0]
    const win = String(path || '').match(/^fixed_windows\.(\d+)/)
    if (win && message) return `Window ${Number(win[1]) + 1}: ${message}`
    if (message) return message
  }
  return j?.error || fallback
}

export default function TapoDevicesClient({ locationName }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tapo/devices')
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Failed to load devices')
      setDevices(j.devices || [])
      setLoadError(null)
    } catch (e) {
      setLoadError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // stateDot/overrideActive read Date.now() at render — without a
  // periodic re-render a device going stale (or an override expiring)
  // would keep its old dot/chip until some unrelated mutation. A 60s
  // tick keeps the status honest; cheap (pure re-render, no fetch).
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const newDevices = devices.filter((d) => d.enabled === false)
  const managed = devices.filter((d) => d.enabled === true)

  if (loading) {
    return (
      <p className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
        <Loader2 size={11} className="animate-spin" /> Loading devices…
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {loadError && <p className="text-[11px] text-red-700">{loadError}</p>}

      {devices.length === 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <p className="text-sm text-un1t-subtle">
            No devices yet — they appear here once the gym bridge reports them.
          </p>
        </div>
      )}

      {newDevices.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-un1t-text">New devices</h2>
          <p className="text-xs text-un1t-subtle mt-0.5 mb-3">
            Reported by the bridge but not yet managed. Name one and adopt it.
          </p>
          <div className="space-y-3">
            {newDevices.map((d) => (
              <AdoptCard key={d.id} device={d} onDone={refresh} />
            ))}
          </div>
        </div>
      )}

      {managed.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-un1t-text">Managed devices</h2>
          <p className="text-xs text-un1t-subtle mt-0.5 mb-3">
            {locationName ? `${locationName} — ` : ''}toggle now, or set a schedule.
          </p>
          <div className="space-y-3">
            {managed.map((d) => (
              <ManagedCard key={d.id} device={d} onDone={refresh} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// A bridge-reported, not-yet-adopted device: name + Adopt.
function AdoptCard({ device, onDone }) {
  const [name, setName] = useState(device.name || device.sidecar_device_id || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function adopt() {
    const trimmed = name.trim()
    if (!trimmed) { setError('Give the device a name first.'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/tapo/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, enabled: true }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(apiErrorMessage(j, 'Adopt failed'))
      await onDone()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <Plug size={15} className="text-un1t-subtle shrink-0" />
        <span className="font-medium text-un1t-text truncate">
          {device.name || device.sidecar_device_id}
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 shrink-0">
          {device.kind}
        </span>
      </div>
      {device.last_seen_at && (
        <p className="text-[10px] text-un1t-subtle mt-1">Last seen {fmtDublin(device.last_seen_at)}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this device"
          className="flex-1 min-w-40 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-sm text-un1t-text"
        />
        <button type="button" onClick={adopt} disabled={busy}
          className="text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Adopt'}
        </button>
      </div>
      {error && <p className="mt-2 text-[11px] text-red-700">{error}</p>}
    </div>
  )
}

// A managed device: state dot + rename/zone + mode editor + toggle.
function ManagedCard({ device, onDone }) {
  const [name, setName] = useState(device.name || '')
  const [zone, setZone] = useState(device.zone || '')
  const [mode, setMode] = useState(device.schedule_mode || 'none')
  const [windows, setWindows] = useState(
    Array.isArray(device.fixed_windows) ? device.fixed_windows : []
  )
  const [leadMin, setLeadMin] = useState(device.class_rule?.lead_min ?? 15)
  const [lagMin, setLagMin] = useState(device.class_rule?.lag_min ?? 10)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)

  const [toggling, setToggling] = useState(false)
  const [toggleError, setToggleError] = useState(null)

  const dot = stateDot(device)
  const hasOverride = overrideActive(device.override)

  // Fixed-window editor — every mutation returns a fresh array/object
  // (immutable), so React sees the change and re-renders.
  function addWindow() {
    if (windows.length >= 8) return
    setWindows((w) => [...w, { days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00' }])
    setSaved(false)
  }
  function removeWindow(i) {
    setWindows((w) => w.filter((_, idx) => idx !== i))
    setSaved(false)
  }
  function toggleDay(i, dayN) {
    setWindows((w) => w.map((win, idx) => {
      if (idx !== i) return win
      const days = win.days.includes(dayN)
        ? win.days.filter((d) => d !== dayN)
        : [...win.days, dayN].sort((a, b) => a - b)
      return { ...win, days }
    }))
    setSaved(false)
  }
  function setWindowTime(i, field, value) {
    setWindows((w) => w.map((win, idx) => (idx === i ? { ...win, [field]: value } : win)))
    setSaved(false)
  }

  async function save() {
    setBusy(true); setError(null); setSaved(false)
    try {
      const body = {
        name: name.trim() || device.name || device.sidecar_device_id,
        zone: zone.trim() ? zone.trim() : null,
        schedule_mode: mode,
      }
      if (mode === 'fixed') body.fixed_windows = windows
      if (mode === 'class') {
        body.class_rule = {
          lead_min: Math.min(120, Math.max(0, Number(leadMin) || 0)),
          lag_min: Math.min(120, Math.max(0, Number(lagMin) || 0)),
        }
      }
      const res = await fetch(`/api/tapo/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(apiErrorMessage(j, 'Save failed'))
      setSaved(true)
      await onDone()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function toggle() {
    setToggling(true); setToggleError(null)
    try {
      const res = await fetch(`/api/tapo/devices/${device.id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: device.last_state === 'on' ? 'off' : 'on' }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(apiErrorMessage(j, 'Toggle failed'))
      await onDone()
    } catch (e) { setToggleError(e.message) } finally { setToggling(false) }
  }

  async function clearOverride() {
    setToggling(true); setToggleError(null)
    try {
      const res = await fetch(`/api/tapo/devices/${device.id}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(apiErrorMessage(j, 'Clear failed'))
      await onDone()
    } catch (e) { setToggleError(e.message) } finally { setToggling(false) }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dot.cls}`} title={dot.title} aria-label={dot.title} />
            <span className="font-semibold text-un1t-text truncate">{device.name || device.sidecar_device_id}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700 shrink-0">
              {device.kind}
            </span>
          </div>
          <p className="text-[10px] text-un1t-subtle mt-1">
            {device.last_seen_at ? `Last seen ${fmtDublin(device.last_seen_at)}` : 'Never seen'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button type="button" onClick={toggle} disabled={toggling}
            className="text-xs font-semibold px-3 py-1.5 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
            {toggling ? <Loader2 size={12} className="animate-spin inline" /> : (device.last_state === 'on' ? 'Turn off' : 'Turn on')}
          </button>
          {hasOverride && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
                Manual until {fmtOverrideUntil(device.override.until)}
              </span>
              <button type="button" onClick={clearOverride} disabled={toggling}
                className="text-[11px] underline text-un1t-subtle disabled:opacity-40">
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      {toggleError && <p className="mt-2 text-[11px] text-red-700">{toggleError}</p>}

      {/* Config */}
      <div className="mt-4 border-t border-un1t-border/60 pt-3 space-y-3">
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-un1t-subtle flex-1 min-w-40">
            Name
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }}
              className="mt-1 w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
          </label>
          <label className="text-xs text-un1t-subtle flex-1 min-w-40">
            Zone (optional)
            <input type="text" value={zone} onChange={(e) => { setZone(e.target.value); setSaved(false) }}
              placeholder="e.g. Studio 1"
              className="mt-1 w-full rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
          </label>
          <label className="text-xs text-un1t-subtle">
            Schedule
            <select value={mode} onChange={(e) => { setMode(e.target.value); setSaved(false) }}
              className="mt-1 block rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text">
              <option value="none">Manual only</option>
              <option value="fixed">Fixed hours</option>
              <option value="class">Class-linked</option>
            </select>
          </label>
        </div>

        {mode === 'fixed' && (
          <div className="space-y-2">
            {windows.length === 0 && (
              <p className="text-[11px] text-un1t-subtle">No windows yet — add one below.</p>
            )}
            {windows.map((win, i) => (
              <div key={i} className="rounded border border-un1t-border/60 p-2 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {DAY_LABELS.map((d) => {
                    const on = win.days.includes(d.n)
                    return (
                      <button key={d.n} type="button" onClick={() => toggleDay(i, d.n)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition ${on ? 'bg-blue-500/10 border-blue-500/40 text-blue-700' : 'border-un1t-border text-un1t-subtle hover:border-un1t-muted'}`}>
                        {d.label}
                      </button>
                    )
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                    On
                    <input type="time" value={win.on} onChange={(e) => setWindowTime(i, 'on', e.target.value)}
                      className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
                  </label>
                  <label className="text-[11px] text-un1t-subtle inline-flex items-center gap-1">
                    Off
                    <input type="time" value={win.off} onChange={(e) => setWindowTime(i, 'off', e.target.value)}
                      className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
                  </label>
                  <button type="button" onClick={() => removeWindow(i)}
                    className="ml-auto text-[11px] text-un1t-subtle hover:text-red-700 inline-flex items-center gap-1">
                    <X size={12} /> Remove
                  </button>
                </div>
              </div>
            ))}
            {windows.length < 8 && (
              <button type="button" onClick={addWindow}
                className="text-[11px] underline text-un1t-subtle inline-flex items-center gap-1">
                <Plus size={12} /> Add window
              </button>
            )}
          </div>
        )}

        {mode === 'class' && (
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-un1t-subtle">
              On (min before class)
              <input type="number" min="0" max="120" value={leadMin}
                onChange={(e) => { setLeadMin(e.target.value); setSaved(false) }}
                className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
            </label>
            <label className="text-xs text-un1t-subtle">
              Off (min after class)
              <input type="number" min="0" max="120" value={lagMin}
                onChange={(e) => { setLagMin(e.target.value); setSaved(false) }}
                className="ml-2 w-16 rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text" />
            </label>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy}
            className="text-xs font-semibold px-3 py-1.5 rounded bg-un1t-text text-un1t-bg disabled:opacity-40">
            {busy ? <Loader2 size={12} className="animate-spin inline" /> : 'Save'}
          </button>
          {saved && <span className="text-[11px] text-emerald-700">Saved ✓</span>}
        </div>
        {error && <p className="text-[11px] text-red-700">{error}</p>}
      </div>
    </div>
  )
}

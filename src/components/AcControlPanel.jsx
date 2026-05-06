// AcControlPanel — staff button + live status for the active
// location's AC. Drops into the Studio Management page next to
// the door unlock list.
//
// Three states:
//   - Not configured (412 from /state): show a friendly "not set up
//     yet" card with a hint to a master.
//   - Configured + idle: big "Turn on AC" button.
//   - Active session: status card with countdown, Manual off + Extend.
//
// We poll /state every 30s while the modal is open so the timer
// stays roughly accurate without hammering Sensibo. Local clock
// drives the visible countdown between polls so it updates every
// second.

'use client'

import { useEffect, useState, useRef } from 'react'
import {
  Snowflake, Loader2, AlertCircle, CheckCircle2, Power, Clock, Plus, Settings,
} from 'lucide-react'

const POLL_INTERVAL_MS = 30_000

export default function AcControlPanel() {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [busy, setBusy] = useState(null) // 'on' | 'off' | 'extend'
  const [actionError, setActionError] = useState(null)
  const [actionInfo, setActionInfo] = useState(null)
  const [tick, setTick] = useState(0)
  const pollTimer = useRef(null)

  async function load() {
    try {
      const r = await fetch('/api/studio-management/ac/state', { cache: 'no-store' })
      const j = await r.json()
      if (r.status === 412) {
        setNotConfigured(true)
        setData(null)
        return
      }
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Failed to load (${r.status})`)
        return
      }
      setNotConfigured(false)
      setLoadError(null)
      setData(j.data)
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  useEffect(() => {
    load()
    pollTimer.current = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(pollTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drive the countdown locally so it updates every second without
  // polling. Resets when load() returns a new active_session.
  useEffect(() => {
    if (!data?.active_session?.auto_off_at) return
    const i = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(i)
  }, [data?.active_session?.auto_off_at])

  async function turnOn() {
    setBusy('on'); setActionError(null); setActionInfo(null)
    try {
      const r = await fetch('/api/studio-management/ac/turn-on', { method: 'POST' })
      const j = await r.json()
      if (r.status === 409 && j.code === 'already_running') {
        setActionInfo(j.error)
        await load()
        return
      }
      if (!r.ok || j.success === false) throw new Error(j.error || `Turn-on failed (${r.status})`)
      await load()
    } catch (e) {
      setActionError(e.message || 'Turn-on failed')
    } finally {
      setBusy(null)
    }
  }

  async function turnOff() {
    if (!confirm('Turn the AC off now?')) return
    setBusy('off'); setActionError(null); setActionInfo(null)
    try {
      const r = await fetch('/api/studio-management/ac/turn-off', { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Turn-off failed (${r.status})`)
      await load()
    } catch (e) {
      setActionError(e.message || 'Turn-off failed')
    } finally {
      setBusy(null)
    }
  }

  async function extend(minutes = 30) {
    setBusy('extend'); setActionError(null); setActionInfo(null)
    try {
      const r = await fetch('/api/studio-management/ac/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) throw new Error(j.error || `Extend failed (${r.status})`)
      await load()
    } catch (e) {
      setActionError(e.message || 'Extend failed')
    } finally {
      setBusy(null)
    }
  }

  // Compute live countdown (seconds left) from active session.
  const session = data?.active_session
  let minsLeft = null
  if (session?.auto_off_at) {
    const ms = new Date(session.auto_off_at).getTime() - Date.now()
    minsLeft = Math.max(0, Math.ceil(ms / 60_000))
  }
  // tick only used to force re-render
  void tick

  if (notConfigured) {
    return (
      <Card>
        <Header />
        <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-4 text-sm text-un1t-light inline-flex items-start gap-2">
          <Settings size={14} className="mt-0.5 shrink-0" />
          <div>
            AC isn&apos;t set up for this location yet. A master can add the Sensibo API key + pod ID under
            <strong className="text-un1t-white"> Settings → Locations → AC.</strong>
          </div>
        </div>
      </Card>
    )
  }

  if (loadError) {
    return (
      <Card>
        <Header />
        <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card>
        <Header />
        <div className="text-sm text-un1t-light inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </Card>
    )
  }

  const { defaults, pod_state, pod_state_error } = data
  const isOn = !!session

  return (
    <Card>
      <Header />
      <p className="text-xs text-un1t-light mb-3">
        Preset:{' '}
        <span className="text-un1t-white font-medium">
          {defaults.mode || 'cool'} · {defaults.temp ?? 18}°C · fan {defaults.fan || 'high'}
        </span>{' '}
        for{' '}
        <span className="text-un1t-white font-medium">{defaults.session_minutes || 90} min</span>.
      </p>

      {pod_state_error && !isOn && (
        <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-2 mb-3 inline-flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          Couldn&apos;t reach Sensibo just now ({pod_state_error}). Button still works — try it.
        </div>
      )}

      {!isOn ? (
        <button
          onClick={turnOn}
          disabled={busy === 'on'}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-base px-5 py-4 rounded-lg inline-flex items-center justify-center gap-2.5 disabled:opacity-50 transition-colors"
        >
          {busy === 'on' ? <Loader2 size={20} className="animate-spin" /> : <Snowflake size={20} />}
          {busy === 'on' ? 'Turning on…' : 'Turn on AC'}
        </button>
      ) : (
        <div className="bg-blue-600/10 border-2 border-blue-500/40 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Snowflake size={28} className="text-blue-300 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-base font-bold text-un1t-white">AC is running</div>
              {session?.profiles?.full_name && (
                <div className="text-xs text-un1t-light mt-0.5">
                  Started by {session.profiles.full_name} · {timeAgo(session.started_at)}
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold text-blue-200 inline-flex items-center gap-1.5">
                <Clock size={18} /> {minsLeft != null ? `${minsLeft} min` : '—'}
              </div>
              <div className="text-[11px] text-un1t-light">until auto-off</div>
            </div>
          </div>

          {pod_state && (
            <div className="text-xs text-un1t-light bg-un1t-black/40 rounded px-3 py-2">
              Sensibo: {pod_state.on ? 'on' : 'off'}
              {pod_state.mode ? ` · ${pod_state.mode}` : ''}
              {pod_state.targetTemperature != null ? ` · ${pod_state.targetTemperature}°C` : ''}
              {pod_state.fanLevel ? ` · fan ${pod_state.fanLevel}` : ''}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => extend(30)}
              disabled={busy === 'extend'}
              className="flex-1 bg-un1t-gray/60 hover:bg-un1t-gray/80 text-un1t-white text-sm font-semibold px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy === 'extend' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Extend +30 min
            </button>
            <button
              onClick={turnOff}
              disabled={busy === 'off'}
              className="flex-1 bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 text-sm font-semibold px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy === 'off' ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
              Turn off now
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {actionError}
        </div>
      )}
      {actionInfo && (
        <div className="mt-3 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-2 inline-flex items-start gap-2">
          <CheckCircle2 size={11} className="mt-0.5 shrink-0" /> {actionInfo}
        </div>
      )}
    </Card>
  )
}

function Header() {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Snowflake size={18} className="text-blue-400" />
      <h3 className="text-sm font-bold text-un1t-white uppercase tracking-wider">Air conditioning</h3>
    </div>
  )
}

function Card({ children }) {
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
      {children}
    </div>
  )
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

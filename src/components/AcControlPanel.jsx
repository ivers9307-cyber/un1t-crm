// AcControlPanel — list of AC devices the active staffer can
// control at the active location. Drops into the Studio Management
// page next to the door unlock list.
//
// STUDIO-AC-DEVICES.3 — rewritten from the single-AC original.
// Reads /api/studio-management/ac/devices (already allowlist-
// filtered server-side) and renders one card per device. Each
// card polls /api/studio-management/ac/devices/[id] independently
// for live vendor state + active session.
//
// Card states (per device):
//   - Idle:    big "Turn on" button.
//   - Active:  status card with countdown + Turn-off + Extend.
//   - Error:   muted error strip; the rest of the panel keeps
//              working so a Sensibo blip doesn't take down the
//              bathroom AC list.

'use client'

import { useEffect, useState } from 'react'
import {
  Snowflake, Loader2, AlertCircle, CheckCircle2, Power, Clock, Settings,
  Plus,
} from 'lucide-react'

const POLL_INTERVAL_MS = 30_000

export default function AcControlPanel() {
  const [devices, setDevices] = useState(null)
  const [loadError, setLoadError] = useState(null)

  async function load() {
    try {
      const r = await fetch('/api/studio-management/ac/devices', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Failed to load (${r.status})`)
        return
      }
      setLoadError(null)
      setDevices(j.data || [])
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }

  useEffect(() => {
    load()
    // Re-fetch the LIST every 30s in case a master enables /
    // disables a device while staff are on the page. Individual
    // device cards drive their own state polls.
    const t = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(t)
  }, [])

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

  if (devices === null) {
    return (
      <Card>
        <Header />
        <div className="text-sm text-un1t-light inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </Card>
    )
  }

  if (devices.length === 0) {
    return (
      <Card>
        <Header />
        <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-4 text-sm text-un1t-light inline-flex items-start gap-2">
          <Settings size={14} className="mt-0.5 shrink-0" />
          <div>
            No AC units are set up for you at this location yet. A master
            adds devices under{' '}
            <strong className="text-un1t-white">Settings → Locations → AC Devices</strong>{' '}
            and ticks the ones you should be able to control on your{' '}
            <strong className="text-un1t-white">staff record</strong>.
          </div>
        </div>
      </Card>
    )
  }

  // STUDIO-AC-GROUPS.1 — bucket devices by `device_group` so the
  // panel renders one section per group with the group name as a
  // sub-heading. Master sets the group on each device from the AC
  // Devices settings tab. NULL group → 'Other' bucket at the
  // bottom. The API already orders devices by group then label, so
  // we just walk the list in order and split on group boundaries.
  const groups = groupDevices(devices)

  return (
    <Card>
      <Header count={devices.length} />
      <div className="space-y-5">
        {groups.map(({ name, devices: groupDevices }) => (
          <div key={name} className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-un1t-light px-1">
              {name}
            </div>
            <div className="space-y-3">
              {groupDevices.map((d) => (
                <DeviceCard key={d.id} device={d} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

function groupDevices(devices) {
  const map = new Map()
  for (const d of devices) {
    const key = d.device_group || 'Other'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(d)
  }
  // Sort: named groups first (alphabetical), 'Other' last.
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === 'Other') return 1
      if (b === 'Other') return -1
      return a.localeCompare(b)
    })
    .map(([name, ds]) => ({ name, devices: ds }))
}

// ============================================================
// DeviceCard — one row per AC unit
// ============================================================

function DeviceCard({ device }) {
  const [state, setState] = useState(null)        // live vendor state + active_session
  const [stateError, setStateError] = useState(null)
  const [busy, setBusy] = useState(null)          // 'on' | 'off' | 'extend'
  const [actionError, setActionError] = useState(null)
  const [actionInfo, setActionInfo] = useState(null)
  const [tick, setTick] = useState(0)

  async function load() {
    try {
      const r = await fetch(`/api/studio-management/ac/devices/${device.id}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setStateError(j.error || `Failed (${r.status})`)
        return
      }
      setStateError(null)
      setState(j.data)
    } catch (e) {
      setStateError(e.message || 'Network error')
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  // Local 1s ticker for the visible countdown.
  useEffect(() => {
    if (!state?.active_session?.auto_off_at) return
    const i = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(i)
  }, [state?.active_session?.auto_off_at])

  async function call(path, action) {
    setBusy(action); setActionError(null); setActionInfo(null)
    try {
      const r = await fetch(`/api/studio-management/ac/devices/${device.id}/${path}`, { method: 'POST' })
      const j = await r.json()
      if (r.status === 409 && j.code === 'already_running') {
        setActionInfo(j.error)
        await load()
        return
      }
      if (!r.ok || j.success === false) throw new Error(j.error || `${action} failed (${r.status})`)
      await load()
    } catch (e) {
      setActionError(e.message || `${action} failed`)
    } finally {
      setBusy(null)
    }
  }

  const session = state?.active_session
  const isOn = !!session
  let minsLeft = null
  if (session?.auto_off_at) {
    const ms = new Date(session.auto_off_at).getTime() - Date.now()
    minsLeft = Math.max(0, Math.ceil(ms / 60_000))
  }
  void tick

  const providerLabel = device.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'
  const presetLabel =
    `${device.default_mode || 'cool'} · ${device.default_temp_c ?? 22}°C` +
    ` · fan ${device.default_fan || 'auto'} · ${device.session_minutes || 30} min`

  return (
    <div className={`rounded-lg p-4 ${isOn ? 'bg-blue-600/10 border-2 border-blue-500/40' : 'bg-un1t-black/40 border border-un1t-gray'}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Snowflake size={16} className={isOn ? 'text-blue-300' : 'text-blue-400'} />
            <span className="text-sm font-bold text-un1t-white truncate">{device.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-un1t-mid font-mono">{providerLabel}</span>
          </div>
          <div className="text-[11px] text-un1t-light mt-0.5">{presetLabel}</div>
        </div>
        {isOn && (
          <div className="text-right shrink-0">
            <div className="text-xl font-bold text-blue-200 inline-flex items-center gap-1.5">
              <Clock size={14} /> {minsLeft != null ? `${minsLeft} min` : '—'}
            </div>
            <div className="text-[10px] text-un1t-light">until auto-off</div>
          </div>
        )}
      </div>

      {stateError && !isOn && (
        <div className="text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-2 mb-2 inline-flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          Couldn&apos;t reach the AC vendor just now ({stateError}). Buttons still work — try them.
        </div>
      )}

      {!isOn ? (
        <button
          onClick={() => call('turn-on', 'on')}
          disabled={busy === 'on'}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-4 py-3 rounded-md inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
        >
          {busy === 'on' ? <Loader2 size={16} className="animate-spin" /> : <Snowflake size={16} />}
          {busy === 'on' ? 'Turning on…' : 'Turn on'}
        </button>
      ) : (
        <div className="space-y-2">
          {session?.profiles?.full_name && (
            <div className="text-[11px] text-un1t-light">
              Started by {session.profiles.full_name} · {timeAgo(session.started_at)}
            </div>
          )}
          {state?.state && (
            <div className="text-[11px] text-un1t-light bg-un1t-black/40 rounded px-3 py-1.5">
              Live: {state.state.on ? 'on' : 'off'}
              {state.state.mode ? ` · ${state.state.mode}` : ''}
              {state.state.target_temp_c != null ? ` · ${state.state.target_temp_c}°C` : ''}
              {state.state.fan ? ` · fan ${state.state.fan}` : ''}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => call('extend', 'extend')}
              disabled={busy === 'extend'}
              className="bg-un1t-gray/30 text-un1t-light border border-un1t-gray hover:text-un1t-white text-xs font-semibold px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy === 'extend' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              +{device.session_minutes || 30} min
            </button>
            <button
              onClick={() => {
                if (!confirm(`Turn ${device.label} off now?`)) return
                call('turn-off', 'off')
              }}
              disabled={busy === 'off'}
              className="bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 text-xs font-semibold px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {busy === 'off' ? <Loader2 size={12} className="animate-spin" /> : <Power size={12} />}
              Turn off
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="mt-2 text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2 inline-flex items-start gap-2">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {actionError}
        </div>
      )}
      {actionInfo && (
        <div className="mt-2 text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded p-2 inline-flex items-start gap-2">
          <CheckCircle2 size={11} className="mt-0.5 shrink-0" /> {actionInfo}
        </div>
      )}
    </div>
  )
}

function Header({ count }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2">
        <Snowflake size={18} className="text-blue-400" />
        <h3 className="text-sm font-bold text-un1t-white uppercase tracking-wider">Air conditioning</h3>
      </div>
      {typeof count === 'number' && count > 0 && (
        <span className="text-[10px] uppercase tracking-wider text-un1t-mid">
          {count} unit{count === 1 ? '' : 's'}
        </span>
      )}
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

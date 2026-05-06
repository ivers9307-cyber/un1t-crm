'use client'

// StudioManagementPanel — door list + per-door unlock buttons.
//
// Lists every door from the active location's UniFi controller via
// /api/studio-management/doors. Clicking a button POSTs to the
// /unlock endpoint, which calls remoteUnlockDoor() on the controller.
// The relay opens for whatever duration the door is configured
// for in UniFi (typical: 5 seconds), then re-locks.
//
// UX details:
//   - Two-stage button: click once to "arm", click again within 3s
//     to actually fire. Stops a stray tap from buzzing the door
//     for everyone in the studio. Pattern matches how UniFi's own
//     mobile app does it.
//   - Per-door spinner during the request.
//   - "Unlocked just now" badge fades after 5s so the operator can
//     see the action took.

import { useEffect, useState } from 'react'
import { DoorOpen, Loader2, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import AcControlPanel from './AcControlPanel'

export default function StudioManagementPanel() {
  const [doors, setDoors] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  async function loadDoors() {
    setRefreshing(true)
    setLoadError(null)
    try {
      const r = await fetch('/api/studio-management/doors', { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLoadError(j.error || `Failed to load doors (${r.status})`)
        setDoors([])
      } else {
        setDoors(j.data || [])
      }
    } catch (e) {
      setLoadError(e.message || 'Network error')
      setDoors([])
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { loadDoors() }, [])

  return (
    <div className="space-y-6">
      {/* Air conditioning — Sensibo-controlled, with a 90-min auto-off
          timer enforced by /api/cron/ac-auto-off. */}
      <AcControlPanel />

      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Doors</h3>
        <button
          type="button"
          onClick={loadDoors}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-xs text-un1t-light hover:text-un1t-white disabled:opacity-50"
        >
          {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>
            <div>{loadError}</div>
            <div className="text-[11px] text-un1t-mid mt-1">
              If UniFi isn&apos;t configured for this location yet, ask a master to fill in the controller settings under Settings → Locations.
            </div>
          </div>
        </div>
      )}

      {doors === null && !loadError && (
        <div className="text-sm text-un1t-light inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading doors…
        </div>
      )}

      {doors && doors.length === 0 && !loadError && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-6 text-center">
          <DoorOpen size={28} className="mx-auto mb-2 text-un1t-light" />
          <p className="text-sm text-un1t-light">
            No doors found on the controller. Add at least one door in the UniFi Access console.
          </p>
        </div>
      )}

      {doors && doors.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {doors.map(d => (
            <DoorTile key={d.id} door={d} />
          ))}
        </div>
      )}
    </div>
  )
}

function DoorTile({ door }) {
  const [stage, setStage] = useState('idle') // 'idle' | 'armed' | 'unlocking' | 'unlocked' | 'error'
  const [error, setError] = useState(null)

  // Auto-disarm after 3s of "armed" inactivity. Tap-twice-to-unlock
  // is only protective if the second tap is intentional.
  useEffect(() => {
    if (stage !== 'armed') return
    const id = setTimeout(() => setStage('idle'), 3000)
    return () => clearTimeout(id)
  }, [stage])

  // Fade the "unlocked" badge after 5s.
  useEffect(() => {
    if (stage !== 'unlocked') return
    const id = setTimeout(() => setStage('idle'), 5000)
    return () => clearTimeout(id)
  }, [stage])

  async function fire() {
    setStage('unlocking')
    setError(null)
    try {
      const r = await fetch('/api/studio-management/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ door_id: door.id, door_name: door.name }),
      })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.error || `Unlock failed (${r.status})`)
        setStage('error')
        return
      }
      setStage('unlocked')
    } catch (e) {
      setError(e.message || 'Network error')
      setStage('error')
    }
  }

  function handleClick() {
    if (stage === 'idle' || stage === 'error') {
      setStage('armed')
      setError(null)
      return
    }
    if (stage === 'armed') {
      fire()
    }
    // unlocking / unlocked → ignore extra clicks until state resets
  }

  const labelByStage = {
    idle: 'Tap to unlock',
    armed: 'Tap again to confirm',
    unlocking: 'Unlocking…',
    unlocked: 'Unlocked',
    error: 'Try again',
  }

  const colorByStage = {
    idle: 'border-un1t-gray hover:border-un1t-mid',
    armed: 'border-amber-500 bg-amber-500/10',
    unlocking: 'border-un1t-mid',
    unlocked: 'border-emerald-500 bg-emerald-500/10',
    error: 'border-red-500 bg-red-500/10',
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={stage === 'unlocking'}
      className={`text-left bg-un1t-dark border rounded-lg p-4 flex items-center gap-3 transition-colors disabled:cursor-wait ${colorByStage[stage]}`}
    >
      <div className="w-10 h-10 rounded-lg bg-un1t-black/40 flex items-center justify-center shrink-0">
        {stage === 'unlocking' ? <Loader2 size={18} className="animate-spin" /> :
         stage === 'unlocked' ? <CheckCircle2 size={18} className="text-emerald-700" /> :
         stage === 'error' ? <AlertCircle size={18} className="text-red-700" /> :
         <DoorOpen size={18} className="text-un1t-light" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-un1t-white truncate">{door.name}</div>
        <div className="text-[11px] text-un1t-light">{labelByStage[stage]}</div>
        {stage === 'error' && error && (
          <div className="text-[11px] text-red-700 mt-1 truncate">{error}</div>
        )}
      </div>
    </button>
  )
}

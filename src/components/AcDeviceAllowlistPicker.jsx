'use client'

// AC-ROLE.1 — AC device allowlist picker, shared by StaffForm (per-user
// override) and RolePermissions (per-role default). Tri-state value:
//   null  → inherit (StaffForm: inherit the role default;
//                     RolePermissions: inherit the code default)
//   []    → explicit none
//   [ids] → exactly those device ids
// `inheritLabel` names the inherit option for the surface.

import { useState } from 'react'

export default function AcDeviceAllowlistPicker({ locationId, locationName, value, onChange, inheritLabel = 'Inherit default' }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [devices, setDevices] = useState(null)

  const inheriting = value === null || value === undefined
  const selected = Array.isArray(value) ? value : []
  const selectedSet = new Set(selected)

  const currentLabel = (() => {
    if (inheriting) return inheritLabel
    if (selected.length === 0) return 'No AC units (explicit none)'
    if (!devices) return `${selected.length} AC unit${selected.length === 1 ? '' : 's'} selected`
    const names = selected.map((id) => devices.find((d) => d.id === id)?.label || id).slice(0, 3)
    const more = selected.length - names.length
    return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ')
  })()

  async function fetchDevices() {
    if (loading) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/ac-devices`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.message || json.error || 'Fetch failed')
      setDevices(json.devices || json.data || [])
    } catch (e) {
      setError(e.message || 'Could not load AC devices')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && devices === null) fetchDevices()
  }
  function toggleDevice(deviceId) {
    const base = inheriting ? [] : selected
    if (selectedSet.has(deviceId)) onChange(base.filter((id) => id !== deviceId))
    else onChange([...base, deviceId])
  }
  function selectAll() { if (devices) onChange(devices.map((d) => d.id)) }
  function selectNone() { onChange([]) }
  function setInherit() { onChange(null) }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm hover:border-un1t-muted"
      >
        <div className="min-w-0">
          <div className="text-xs text-un1t-subtle">Studio Management AC units</div>
          <div className="truncate">{currentLabel}</div>
        </div>
        <span className="text-un1t-subtle text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="rounded-md border border-un1t-border bg-un1t-bg p-2 space-y-1">
          <div className="flex items-center gap-3 px-2 py-1 text-[11px]">
            <button type="button" onClick={setInherit} className={inheriting ? 'text-blue-300 font-semibold' : 'text-un1t-subtle hover:text-un1t-text'}>
              {inheritLabel}
            </button>
            <span className="text-un1t-muted">·</span>
            <button type="button" onClick={selectAll} className="text-blue-300 hover:text-blue-200">All</button>
            <button type="button" onClick={selectNone} className="text-blue-300 hover:text-blue-200">None</button>
          </div>
          <div className="border-t border-un1t-border/50 my-1" />
          {loading && <div className="text-xs text-un1t-subtle px-2 py-1.5">Loading AC devices from {locationName}…</div>}
          {error && <div className="text-xs text-red-700 px-2 py-1.5">{error}</div>}
          {!loading && !error && devices && (
            <div className="max-h-64 overflow-y-auto">
              {devices.length === 0 && (
                <div className="text-xs text-un1t-subtle px-2 py-1.5">
                  No AC devices configured at this location. Add devices under Settings → Locations → AC Devices first.
                </div>
              )}
              {devices.map((d) => {
                const isOn = !inheriting && selectedSet.has(d.id)
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDevice(d.id)}
                    className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 flex items-center gap-2"
                  >
                    <span className={`inline-block w-3.5 h-3.5 rounded border flex items-center justify-center text-[10px] ${isOn ? 'bg-blue-500 border-blue-500 text-white' : 'border-un1t-border text-transparent'}`}>
                      {isOn ? '✓' : ''}
                    </span>
                    <span className="truncate">{d.label}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-un1t-muted font-mono shrink-0">
                      {d.provider === 'thinq' ? 'LG ThinQ' : 'Sensibo'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

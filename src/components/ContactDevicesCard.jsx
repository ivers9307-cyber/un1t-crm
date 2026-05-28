'use client'

// Heart-rate device registry on a contact's profile.
// Operator (owner/manager/head_coach) can register a chest strap
// for a member by typing the strap MAC + a label. Removes via the
// trash icon. The strap auto-routes the member's HR samples to
// their in-progress booking the next time they wear it in studio.
//
// Customer self-service goes through champ-app /account/devices —
// also writes to the same contact_devices table via RLS.

import { useEffect, useState } from 'react'
import { Plus, Trash2, Watch, Heart } from 'lucide-react'

const MANUFACTURERS = ['polar', 'wahoo', 'coospo', 'garmin', 'apple', 'whoop', 'unknown']

export default function ContactDevicesCard({ contactId, canEdit }) {
  const [devices, setDevices] = useState(null)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)

  async function load() {
    setError(null)
    const res = await fetch(`/api/contacts/${contactId}/devices`)
    const data = await res.json()
    if (!res.ok || !data.ok) {
      setError(data.error || 'Failed to load devices')
      setDevices([])
      return
    }
    setDevices(data.devices)
  }

  useEffect(() => { load() }, [contactId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(input) {
    const res = await fetch(`/api/contacts/${contactId}/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to add device')
    }
    setAdding(false)
    await load()
  }

  async function handleDelete(deviceId) {
    if (!confirm('Remove this device? Their HR will no longer auto-route at the studio.')) return
    const res = await fetch(`/api/contacts/${contactId}/devices/${deviceId}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      setError(data.error || 'Failed to delete')
      return
    }
    await load()
  }

  return (
    <div className="rounded-xl border border-un1t-border bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Heart size={16} className="text-red-500" />
          <h3 className="text-sm font-semibold">Heart rate devices</h3>
        </div>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <Plus size={13} /> Add
          </button>
        )}
      </div>

      {devices === null && (
        <p className="mt-3 text-sm text-un1t-subtle">Loading…</p>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600">{error}</p>
      )}

      {devices && devices.length === 0 && !adding && (
        <p className="mt-3 text-sm text-un1t-subtle">
          No devices registered. The member&apos;s HR won&apos;t auto-route at the
          studio until a chest strap MAC is added here, or by the member
          via their app account.
        </p>
      )}

      {devices && devices.length > 0 && (
        <ul className="mt-3 space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-md border border-un1t-border bg-un1t-surface p-2.5"
            >
              <DeviceIcon type={d.device_type} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {d.label || d.identifier}
                  {!d.is_active && (
                    <span className="ml-2 inline-block rounded-full bg-un1t-border px-1.5 py-0.5 text-[10px] text-un1t-subtle">
                      inactive
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-un1t-subtle">
                  {d.identifier}
                  {d.manufacturer && ` · ${d.manufacturer}`}
                  {d.added_by_contact && ' · self-added'}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => handleDelete(d.id)}
                  className="rounded p-1.5 text-un1t-subtle hover:bg-red-500/10 hover:text-red-600"
                  title="Remove device"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddDeviceForm
          onCancel={() => setAdding(false)}
          onSubmit={handleAdd}
        />
      )}
    </div>
  )
}

function DeviceIcon({ type }) {
  if (type === 'watch') return <Watch size={16} className="shrink-0 text-un1t-subtle" />
  return <Heart size={16} className="shrink-0 text-red-500" />
}

function AddDeviceForm({ onSubmit, onCancel }) {
  const [protocol, setProtocol] = useState('ble')
  const [identifier, setIdentifier] = useState('')
  const [label, setLabel] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await onSubmit({
        device_type: 'chest_strap', // v1: only straps are addable from the operator UI
        protocol,
        identifier: identifier.trim(),
        label: label.trim() || null,
        manufacturer: manufacturer || null,
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const isAnt = protocol === 'ant'

  return (
    <form onSubmit={submit} className="mt-4 space-y-2 rounded-md border border-un1t-border bg-un1t-surface p-3">
      <div>
        <label className="block text-xs font-medium text-un1t-subtle">Protocol</label>
        <div className="mt-1 flex gap-2">
          {[['ble', 'Bluetooth'], ['ant', 'ANT+']].map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              onClick={() => setProtocol(val)}
              className={`flex-1 rounded-md border px-2.5 py-1.5 text-xs font-medium ${
                protocol === val
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-un1t-border bg-un1t-bg text-un1t-subtle hover:text-un1t-text'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-un1t-subtle">
          {isAnt ? 'ANT+ device number' : 'Strap MAC'}
        </label>
        <input
          type="text"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder={isAnt ? '12345' : 'AA:BB:CC:DD:EE:FF'}
          className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 font-mono text-sm tracking-tight"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-medium text-un1t-subtle">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Polar H10"
            className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-un1t-subtle">Manufacturer</label>
          <select
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-bg px-2.5 py-1.5 text-sm"
          >
            <option value="">—</option>
            {MANUFACTURERS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !identifier.trim()}
          className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-un1t-subtle hover:text-un1t-text"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

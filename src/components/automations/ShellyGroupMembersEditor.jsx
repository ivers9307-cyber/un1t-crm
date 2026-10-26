// SHELLYGROUPS.6 — choose which devices a group runs.
//
// PUT /api/shelly/groups/[id]/devices REPLACES the membership, and JOINING
// clears the device's own schedule and its manual switch (the route's rule 2:
// leaving a group must never revive a stale, invisible schedule). That is a
// real loss for a plug that had its own hours, so the editor says it in words
// the moment a device is ticked, BEFORE Save — never after.
//
// A device in another group is listed with that group's name: ticking it moves
// it here (a device is in at most one group), and the operator should see that
// it is leaving somewhere. Leaving commands nothing; the device stays as it is.

'use client'

import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui'
import { fetchJson, errorText, jsonBody } from './shelly-fetch'

export const JOIN_WARNING =
  "These plugs will follow this group's schedule. Their own schedule and any manual switch are cleared."

const deviceLabel = (d) => d.name || `${d.model || 'Shelly'} · ${String(d.device_id || '').slice(-4)}`

export default function ShellyGroupMembersEditor({ group, devices = [], groups = [], onSaved, onCancel }) {
  const current = Array.isArray(group.device_ids) ? group.device_ids : []
  const [selected, setSelected] = useState(() => new Set(current))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const joining = [...selected].filter((id) => !current.includes(id))
  const leaving = current.filter((id) => !selected.has(id))
  const dirty = joining.length > 0 || leaving.length > 0

  function flip(id) {
    setError(null)
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save() {
    if (!dirty) return
    setBusy(true)
    setError(null)
    // The page's own device order, so the request reads the way the list does.
    const deviceIds = devices.map((d) => d.id).filter((id) => selected.has(id))
    const res = await fetchJson(`/api/shelly/groups/${group.id}/devices`, jsonBody('PUT', { device_ids: deviceIds }))
    setBusy(false)
    if (!res.ok || res.json?.success === false) {
      setError(errorText(res.json, 'Could not save the devices'))
      return
    }
    await onSaved?.(res.json)
  }

  return (
    <div className="space-y-2 rounded border border-un1t-border/60 p-3">
      <p className="text-xs font-semibold text-un1t-text">Devices in {group.name}</p>
      {devices.length === 0 ? (
        <p className="text-xs text-un1t-subtle">No devices set up here yet.</p>
      ) : (
        <ul className="space-y-1">
          {devices.map((d) => {
            const elsewhere = d.group_id && d.group_id !== group.id ? groupName.get(d.group_id) : null
            return (
              <li key={d.id}>
                <label className="inline-flex items-center gap-2 text-xs text-un1t-text">
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => flip(d.id)} />
                  {deviceLabel(d)}
                  {elsewhere && (
                    <span className="rounded-full bg-un1t-muted/10 px-2 py-0.5 text-[11px] text-un1t-subtle">In {elsewhere}</span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {joining.length > 0 && (
        <p className="flex items-start gap-1 text-xs text-amber-700">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {JOIN_WARNING}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" loading={busy} disabled={!dirty} onClick={save}>Save devices</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>

      {error && (
        <p className="flex items-start gap-1 text-xs text-red-700" role="alert">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  )
}

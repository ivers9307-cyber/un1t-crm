'use client'

// STAFF-DEV.6 — per-staff Devices card on the staff profile. Answers
// "why isn't this person's attendance stamping?": every registered
// device with its version, last-seen and background-location permission.
//
// TRADEOFF: this fetches the whole fleet from /api/staff-devices and
// renders only this profile's entry. At ~22 staff / ~11 devices that is
// a few KB, and it keeps ONE endpoint and ONE set of verdict rules for
// all three surfaces — a per-profile endpoint would be a second thing to
// keep in agreement. Revisit if the estate grows an order of magnitude.
//
// Loading and error states render inline; this card must never take the
// staff form down with it.

import { useEffect, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { geofencePermissionChip, CHIP_TONE_CLASSES as TONE } from '@/lib/geofence-permission-chips'

const CHIP = 'text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full'


function fmtWhen(iso) {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return 'never'
  const d = Math.floor(ms / 86400000)
  if (d < 1) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d} days ago`
  return `${Math.floor(d / 30)}mo ago`
}

// null = the device has never reported (client below 2.2.0, or pre-STAFF-DEV
// JS). It renders as "—", NEVER as denied — absence of data is not a denial,
// and that distinction is the diagnostic value. Labels/tones come from
// @/lib/geofence-permission-chips (GEO-ATT.22) so this surface cannot drift
// from the other two or from the DB's CHECK constraint.
function PermissionChip({ value }) {
  const chip = geofencePermissionChip(value)
  if (!chip) return <span className="text-xs text-un1t-muted">—</span>
  return <span className={`${CHIP} ${chip.className}`}>{chip.label}</span>
}

export default function StaffDevicesCard({ profileId }) {
  const [state, setState] = useState({ status: 'loading', entry: null, target: null, error: null })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/staff-devices')
        const json = await res.json()
        if (cancelled) return
        if (!res.ok || !json.success) {
          setState({ status: 'error', entry: null, target: null, error: json.error || 'Failed to load devices' })
          return
        }
        const entry = (json.data.staff || []).find(s => s.id === profileId) || null
        setState({ status: 'ready', entry, target: json.data.target_version, error: null })
      } catch {
        if (!cancelled) {
          setState({ status: 'error', entry: null, target: null, error: 'Failed to load devices' })
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [profileId])

  const devices = state.entry?.devices || []
  const verdict = state.entry?.verdict

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle inline-flex items-center gap-1.5">
            <Smartphone size={13} /> Devices
          </h3>
          <p className="text-xs text-un1t-subtle mt-1">
            Registered app installs, their version and background-location permission.
            {state.target ? ` Latest version in use: ${state.target}.` : ''}
          </p>
        </div>
        {verdict?.kind === 'outdated' && (
          <span className={`${CHIP} ${TONE.amber} shrink-0`}>Outdated</span>
        )}
      </div>

      {state.status === 'loading' && (
        <div className="text-xs text-un1t-subtle">Loading devices…</div>
      )}

      {state.status === 'error' && (
        <div className="text-xs text-amber-700">{state.error}</div>
      )}

      {state.status === 'ready' && devices.length === 0 && (
        <div className="text-xs text-un1t-subtle">
          No app installed — this staff member has never registered a device.
        </div>
      )}

      {state.status === 'ready' && devices.length > 0 && (
        <div className="divide-y divide-un1t-border">
          {devices.map((d) => (
            <div
              key={d.id}
              className={`flex items-center justify-between gap-3 py-2 ${d.stale ? 'opacity-60' : ''}`}
            >
              <div className="min-w-0">
                <div className="text-sm text-un1t-text truncate">
                  {d.device_name || 'Unnamed device'}
                  <span className="text-un1t-muted"> · {d.platform || '—'}</span>
                  {/* "Current" is whichever row the verdict keyed off —
                      read from the server's decision, not re-derived. */}
                  {d.id === verdict?.deviceId && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-un1t-subtle">Current</span>
                  )}
                </div>
                <div className="text-xs text-un1t-subtle">
                  {d.app_version || 'version unknown'} · last seen {fmtWhen(d.last_seen_at)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {d.stale && <span className={`${CHIP} ${TONE.neutral}`}>Stale</span>}
                <PermissionChip value={d.geofence_permission} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

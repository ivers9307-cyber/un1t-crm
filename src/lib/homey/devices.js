// HOMEYD.1 — pure Homey mappers + planCommands for the direct-control
// reconcile cron (see docs/superpowers/specs/2026-08-01-homey-direct-control-design.md).
//
// Port of champ-bridge's src/homey.js (git -C ~/code/champ-bridge show
// 4511353:src/homey.js), reviewed + merged there today. Two differences
// from the source: the row key is `id` → `sidecar_device_id` (CRM
// vocabulary — this repo's tapo_devices column, mig 372), and
// createHomeyActuation/homeyRequestJson do NOT move here (that's
// src/lib/homey/client.js's job — HOMEYD.2). The `homey:` prefix is
// applied here and stripped by the client, matching the source's split.
//
// Scope: every Homey device exposing an `onoff` capability (Richard,
// 2026-08-01) — the CRM adopt flow (src/lib/homey/reconcile.js,
// HOMEYD.3) auto-registers them disabled.

import { desiredState } from '@/lib/schedule/desired-state'

const HOMEY_PREFIX = 'homey:'

function homeyDeviceList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return Object.values(raw)
  return []
}

// capabilities array is authoritative when present — an EMPTY array
// excludes the device even if capabilitiesObj still carries an onoff
// entry (stale/residual data); capabilitiesObj is only a fallback when
// the array itself is absent.
const hasOnoff = (d) =>
  Array.isArray(d?.capabilities) ? d.capabilities.includes('onoff') : !!d?.capabilitiesObj?.onoff

const controllableDevices = (raw) =>
  homeyDeviceList(raw).filter((d) => d && typeof d.id === 'string' && d.id && hasOnoff(d))

// → [{ sidecar_device_id: 'homey:<id>', kind: 'plug'|'switch', name_hint? }]
export function mapHomeyDevices(raw) {
  return controllableDevices(raw).map((d) => {
    const row = { sidecar_device_id: HOMEY_PREFIX + d.id, kind: d.class === 'socket' ? 'plug' : 'switch' }
    if (d.name) row.name_hint = String(d.name)
    return row
  })
}

// → [{ sidecar_device_id, state: 'on'|'off'|null, reachable }]. `state` is
// strictly boolean-derived, never guessed: a missing/non-boolean onoff
// value is null, and an unavailable device is null + reachable false
// regardless of any stale onoff value, so planCommands skips it as
// unreachable. A null state alone (device reachable, onoff value just
// missing/non-boolean) does NOT skip — planCommands still commands a
// reachable device with unknown state toward the desired state.
export function mapHomeyStates(raw) {
  return controllableDevices(raw).map((d) => {
    const reachable = d.available !== false
    const v = d.capabilitiesObj?.onoff?.value
    const state = !reachable ? null : v === true ? 'on' : v === false ? 'off' : null
    return { sidecar_device_id: HOMEY_PREFIX + d.id, state, reachable }
  })
}

// Diffs each enabled tapo_devices row's desired state (via the existing
// schedule engine — override/fixed/class semantics untouched) against the
// last-reported Homey state, and returns only the commands that would
// actually change something. Idempotent by construction: a repeat call
// against unchanged inputs returns [].
export function planCommands(deviceRows, stateRows, nowMs, today, occurrences) {
  const actualByDevice = new Map((stateRows || []).map((s) => [s.sidecar_device_id, s]))
  const commands = []
  for (const d of deviceRows || []) {
    if (d.enabled === false) continue // re-guard: caller is expected to have filtered already

    const desired = desiredState(d, nowMs, today, occurrences)
    if (desired !== 'on' && desired !== 'off') continue // null = unmanaged

    const actual = actualByDevice.get(d.sidecar_device_id)
    if (!actual) continue // unknown to Homey — nothing to command
    if (actual.reachable === false) continue
    if (actual.state === desired) continue // already in the desired state

    commands.push({ sidecar_device_id: d.sidecar_device_id, on: desired === 'on' })
  }
  return commands
}

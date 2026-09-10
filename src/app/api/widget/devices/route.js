// WIDGET.1 — GET /api/widget/devices, the data source for the iOS
// home-screen widget's configuration picker: "what can this person
// actually control at this studio?"
//
// WHY THIS COMPOSES EXISTING GATES INSTEAD OF INVENTING ONE
//   Every one of the four kinds already has a real, load-bearing gate
//   somewhere else in the app — the doors route's studio_management check
//   plus the UNIFI-DOORS-SCOPE allowlist, the AC panel's studio_management
//   check, the Shelly panel's device_control check, the Sonos panel's
//   device_control check. This route does not decide who may control what;
//   it reuses those SAME decisions (hasPermissionForLocation with the SAME
//   keys) so the picker and the control action can never disagree. A picker
//   that offered a button the server would go on to refuse is a bug the
//   operator experiences as "the widget is broken" — the button looked
//   real, was tapped, and did nothing (or errored) at press time, with no
//   way for the operator to know why. Gating identically here is what keeps
//   the picker honest about what the widget can actually do later.
//
// TWO OF THE FOUR SOURCES ARE LIVE THIRD-PARTY CALLS (UniFi doors, Sonos
// players), so Promise.allSettled + a `degraded` list is the normal case,
// not defensive padding — one flaky integration must not blank the other
// three kinds the operator could otherwise configure.
//
// 🔴 Doors MUST come from listAllowedDoors (src/lib/studio-doors.js), never
// a direct listDoors() call. That helper applies the per-user
// profile_locations.unifi_door_ids allowlist added by migration 182
// (UNIFI-DOORS-SCOPE) after the doors endpoint used to return every door on
// the controller, unfiltered, to any studio_management user. Re-deriving
// the intersection here — instead of calling the one extracted helper —
// would be exactly how that exposure comes back.
//
// 🔴 Speakers MUST come from Sonos PLAYERS, never groups. Player ids are
// permanent; group ids are ephemeral (src/lib/sonos/groups.js:28). A widget
// stores its configured device id permanently, so a button bound to a
// group id breaks the moment anyone regroups the speakers — silently, and
// only for whoever had that widget. The control action resolves group ids
// from player ids at press time via resolveGroupIds(), exactly as the
// Sonos schedules already do.
//
// Sonos "not connected" (and UniFi "not configured") are CONFIGURATION
// states, not failures of a live call — they resolve to an ordinary empty
// list for that kind, not an entry in `degraded`. Reporting a studio that
// simply hasn't linked its Sonos account as "degraded" would make the
// picker look broken when nothing has actually gone wrong.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { listAllowedDoors } from '@/lib/studio-doors'
import { getSonosConfig, withFreshToken, sonosGetGroups } from '@/lib/sonos/client'
import { mapGroups } from '@/lib/sonos/groups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── door ─────────────────────────────────────────────────────────────────

async function fetchDoorSource(db, user, locationId) {
  // Location-row lookup stays here (the caller), same split as the doors
  // route itself — it's a route-level concern, not part of the
  // allowlist-intersection logic that listAllowedDoors owns.
  const { data: location, error } = await db
    .from('locations')
    .select('id, name, settings')
    .eq('id', locationId)
    .single()
  if (error || !location) {
    throw new Error(`door: location lookup failed${error ? `: ${error.message}` : ''}`)
  }

  const result = await listAllowedDoors(db, { user, location, locationId })
  if (!result.ok) {
    // UniFi not configured for this location is a configuration state, not
    // a live-call failure — same posture as Sonos "not connected" below.
    if (result.reason === 'not_configured') return []
    throw new Error(`door: ${result.reason === 'unifi_error' ? result.message : result.reason}`)
  }
  return result.doors.map((d) => ({ kind: 'door', id: d.id, label: d.name }))
}

// ── ac ───────────────────────────────────────────────────────────────────

async function fetchAcSource(db, locationId) {
  const { data, error } = await db
    .from('ac_devices')
    .select('id, label')
    .eq('location_id', locationId)
    // enabled=false is ac_devices' soft-delete flag (mig 210, mirrored by
    // mig 214's checklist_templates comment) — a disabled row is a removed
    // device, not merely "off", and offering it would be the same class of
    // "button the server will refuse" this route exists to avoid.
    .eq('enabled', true)
  if (error) throw new Error(`ac: ${error.message}`)
  return (data || []).map((d) => ({ kind: 'ac', id: d.id, label: d.label }))
}

// ── plug ─────────────────────────────────────────────────────────────────

async function fetchPlugSource(db, locationId) {
  const { data, error } = await db
    .from('shelly_devices')
    .select('id, name')
    .eq('location_id', locationId)
  if (error) throw new Error(`plug: ${error.message}`)
  return (data || []).map((d) => ({ kind: 'plug', id: d.id, label: d.name }))
}

// ── speaker ──────────────────────────────────────────────────────────────

async function fetchSpeakerSource(db, locationId) {
  const cfg = getSonosConfig()
  if (!cfg || cfg.error) return [] // dormant/misconfigured deploy — no Sonos at all, not a failure
  const tok = await withFreshToken(db, locationId, cfg)
  if (!tok.ok) return [] // not_connected / db_error / refresh_failed — a config state for THIS studio, not this call failing
  const groupsRes = await sonosGetGroups(tok.token, tok.householdId)
  if (!groupsRes.ok) {
    throw new Error(`speaker: groups fetch failed (status ${groupsRes.statusCode})`)
  }
  // 🔴 players, never groups — see file header.
  const { players } = mapGroups(groupsRes.body)
  return players.map((p) => ({ kind: 'speaker', id: p.id, label: p.name }))
}

// ── assembler ────────────────────────────────────────────────────────────

export const GET = withAuth(
  { permission: null, location: true, allowWidgetToken: true },
  async ({ user, db, locationId }) => {
    const sources = []
    if (hasPermissionForLocation(user, locationId, 'studio_management')) {
      sources.push(['door', fetchDoorSource(db, user, locationId)])
      sources.push(['ac', fetchAcSource(db, locationId)])
    }
    if (hasPermissionForLocation(user, locationId, 'device_control')) {
      sources.push(['plug', fetchPlugSource(db, locationId)])
      sources.push(['speaker', fetchSpeakerSource(db, locationId)])
    }

    const settled = await Promise.allSettled(sources.map(([, p]) => p))

    const devices = []
    const degraded = []
    settled.forEach((s, i) => {
      const [kind] = sources[i]
      if (s.status === 'fulfilled') {
        devices.push(...s.value)
      } else {
        console.warn(`[widget-devices] source '${kind}' failed: ${s.reason?.message || s.reason}`)
        degraded.push(kind)
      }
    })

    return NextResponse.json({ success: true, data: { devices, degraded } })
  }
)

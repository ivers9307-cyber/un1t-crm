// src/app/api/bridge/tapo/state/route.js
//
// TAPO-T1 — the bridge reports actuals after each reconcile tick.
// Devices the CRM doesn't know yet are auto-registered as
// enabled=false rows: that IS the adopt flow (staff name + enable
// them in /automations/devices). On/off only — no other telemetry.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  devices: z.array(z.object({
    sidecar_device_id: z.string().min(1).max(200),
    kind: z.enum(['plug', 'switch']).optional(),
    state: z.enum(['on', 'off']).nullable(),
    reachable: z.boolean().optional(),
    name_hint: z.string().max(120).nullable().optional(),
  })).max(200),
})

export async function POST(request) {
  const bridge = await verifyBridgeToken(request)
  if (!bridge) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, Body)
  if (!v.ok) return v.response
  const db = createServerClient()
  const locationId = bridge.locationId
  const nowIso = new Date().toISOString()

  // ≤50 devices per location — the per-row loop is fine at this scale.
  //
  // Why select-then-branch instead of a single upsert: on conflict,
  // supabase-js upsert updates EVERY supplied column, so a payload
  // carrying the insert defaults (enabled=false, schedule_mode='none',
  // kind, name) would stomp an adopted device's config on each report;
  // a safe-columns-only payload would insert discoveries without
  // kind/name_hint (the adopt-flow affordance). So we branch, check
  // every error honestly, and treat an insert 23505 as the benign
  // concurrent-registration race (fall back to the update path so the
  // report isn't dropped).
  let updated = 0
  let discovered = 0
  let failed = 0
  for (const d of v.data.devices) {
    const patch = { last_state: d.state, updated_at: nowIso }
    if (d.reachable !== false) patch.last_seen_at = nowIso

    const { data: existing, error: selErr } = await db.from('tapo_devices')
      .select('id').eq('location_id', locationId)
      .eq('sidecar_device_id', d.sidecar_device_id).maybeSingle()
    if (selErr) {
      // A transient read failure must NOT fall through to the insert
      // branch (it would 23505 against a row that exists).
      logWarn('bridge-tapo-state', 'device lookup failed', {
        sidecarDeviceId: d.sidecar_device_id, err: selErr.message,
      })
      failed++
      continue
    }

    if (existing) {
      const { error: updErr } = await db.from('tapo_devices').update(patch).eq('id', existing.id)
      if (updErr) {
        logWarn('bridge-tapo-state', 'state update failed', {
          sidecarDeviceId: d.sidecar_device_id, err: updErr.message,
        })
        failed++
      } else {
        updated++
      }
      continue
    }

    const { error: insErr } = await db.from('tapo_devices').insert({
      location_id: locationId,
      sidecar_device_id: d.sidecar_device_id,
      kind: d.kind || 'plug',
      name: d.name_hint || null,
      enabled: false,
      schedule_mode: 'none',
      last_state: d.state,
      last_seen_at: nowIso,
      updated_at: nowIso,
    })
    if (!insErr) {
      discovered++
    } else if (insErr.code === '23505') {
      // Benign race on UNIQUE(location_id, sidecar_device_id): a
      // concurrent report (Pi restart mid-tick) registered this device
      // between our select and insert. Apply the state patch instead.
      const { error: raceUpdErr } = await db.from('tapo_devices').update(patch)
        .eq('location_id', locationId).eq('sidecar_device_id', d.sidecar_device_id)
      if (raceUpdErr) {
        logWarn('bridge-tapo-state', 'post-race state update failed', {
          sidecarDeviceId: d.sidecar_device_id, err: raceUpdErr.message,
        })
        failed++
      } else {
        updated++
      }
    } else {
      logWarn('bridge-tapo-state', 'device auto-register failed', {
        sidecarDeviceId: d.sidecar_device_id, err: insErr.message,
      })
      failed++
    }
  }
  return NextResponse.json({ success: true, updated, discovered, failed })
}

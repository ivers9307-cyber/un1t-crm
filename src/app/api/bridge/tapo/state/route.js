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
  let updated = 0
  let discovered = 0
  for (const d of v.data.devices) {
    const { data: existing } = await db.from('tapo_devices')
      .select('id').eq('location_id', locationId)
      .eq('sidecar_device_id', d.sidecar_device_id).maybeSingle()
    if (existing) {
      const patch = { last_state: d.state, updated_at: nowIso }
      if (d.reachable !== false) patch.last_seen_at = nowIso
      await db.from('tapo_devices').update(patch).eq('id', existing.id)
      updated++
    } else {
      await db.from('tapo_devices').insert({
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
      discovered++
    }
  }
  return NextResponse.json({ success: true, updated, discovered })
}

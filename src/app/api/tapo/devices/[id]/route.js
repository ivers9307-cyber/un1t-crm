// PATCH /api/tapo/devices/[id]
//
// TAPO-T1.4 — staff-facing config for one Tapo device: rename, set
// zone label, enable/adopt, and choose the schedule (none | fixed
// windows | class-linked). The pure desired-state engine
// (src/lib/schedule/desired-state.js) reads these fields; the bridge
// executes.
//
// Service-role route: RLS does nothing, so we authorize in app code.
// getCurrentUser (401) → hasPermission (403) → uuidLike guard on the
// id (404, never 500) → load the row and 404 when it's missing OR
// belongs to another location (404-not-403 so ids can't be
// enumerated across locations).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const FixedWindow = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  on: z.string().regex(HHMM, 'Use HH:MM (24h)'),
  off: z.string().regex(HHMM, 'Use HH:MM (24h)'),
})
  // The engine treats off <= on as an overnight span, so on === off
  // would silently become a 24-hour always-on window on a physical
  // device — reject the copy-paste typo here.
  .refine(w => w.on !== w.off, { message: 'on and off must differ', path: ['off'] })

const ClassRule = z.object({
  lead_min: z.number().int().min(0).max(120),
  lag_min: z.number().int().min(0).max(120),
})

// All fields optional — a config PATCH sends only what changed.
// `name` is deliberately min(1) and non-nullable: once adopted a
// device can be renamed but not blanked back to anonymous. `zone`
// is nullable by design — it's just a label, clearing it is fine.
const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  zone: z.string().max(60).nullable().optional(),
  enabled: z.boolean().optional(),
  schedule_mode: z.enum(['none', 'fixed', 'class']).optional(),
  fixed_windows: z.array(FixedWindow).max(8).optional(),
  class_rule: ClassRule.optional(),
})

const EDITABLE = ['name', 'zone', 'enabled', 'schedule_mode', 'fixed_windows', 'class_rule']

export async function PATCH(request, props) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const params = await props.params
  // Invalid id shape → 404 (not 500, not 403). A garbage id must not
  // reach the DB or leak whether any row exists.
  if (!uuidLike.safeParse(params?.id).success) {
    return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
  }

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    // Load first so a cross-location row 404s the same as a missing
    // one — no ID enumeration across locations.
    const { data: row, error: loadErr } = await db
      .from('tapo_devices')
      .select('id, location_id')
      .eq('id', params.id)
      .maybeSingle()
    if (loadErr) {
      return NextResponse.json({ success: false, error: loadErr.message }, { status: 500 })
    }
    if (!row || row.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Device not found' }, { status: 404 })
    }

    const validation = await validateBody(request, Body)
    if (!validation.ok) return validation.response
    const body = validation.data

    // Note: flipping enabled:false intentionally does NOT clear
    // `override` — the engine ignores overrides on disabled devices,
    // and any override will have expired by realistic re-enable time.
    const patch = {}
    for (const key of EDITABLE) {
      if (key in body) patch[key] = body[key]
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'No editable fields supplied.' }, { status: 400 })
    }
    patch.updated_at = new Date().toISOString()

    const { data: updated, error: updErr } = await db
      .from('tapo_devices')
      .update(patch)
      .eq('id', params.id)
      .select('*')
      .single()
    if (updErr) {
      return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, device: updated })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || String(e) }, { status: 500 })
  }
}

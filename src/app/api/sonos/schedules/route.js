// SONOS.14 — schedule list + create.
//
// SHELLY-UI.1 — the window vocabulary (HHMM, the overlap detector, the
// same-boundary rule) moved to src/lib/schedule/windows.js so the Shelly
// surface validates a fixed window with the same code, not a copy. This
// file keeps Window and SchedulePayload — same names, same meanings —
// composing exactly what they used to.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { WindowBase, NOT_SAME_BOUNDARY, windowsOverlapIssue } from '@/lib/schedule/windows'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Named so the query's cap and the truncation check can never drift apart.
const MAX_SCHEDULES_PER_LOCATION = 50

// The refine comes AFTER the extend, and it has to: .refine() returns a
// ZodEffects, which has no .extend(), so attaching the same-boundary rule
// to the shared base would make these two fields unaddable. That is why
// windows.js exports the rule as a predicate + message pair instead.
export const Window = WindowBase.extend({
  volume: z.number().int().min(0).max(100),
  favorite_id: z.string().min(1).max(128),
}).refine(NOT_SAME_BOUNDARY.check, { message: NOT_SAME_BOUNDARY.message })

export const SchedulePayload = z.object({
  name: z.string().min(1).max(80).optional(),
  player_ids: z.array(z.string().min(1)).max(32).optional(),
  enabled: z.boolean().optional(),
  windows: z.array(Window).max(16).superRefine(windowsOverlapIssue).optional(),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
    .limit(MAX_SCHEDULES_PER_LOCATION)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  // A cap that truncates in silence reads as "that's everything". Say so
  // instead — same fix the reconcile cron already carries for its own cap.
  if (data?.length === MAX_SCHEDULES_PER_LOCATION) {
    logWarn('sonos-schedules', 'schedule cap reached, list may be truncated', {
      locationId,
      cap: MAX_SCHEDULES_PER_LOCATION,
    })
  }
  return NextResponse.json({ success: true, schedules: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const parsed = SchedulePayload.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid payload' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .insert({ location_id: locationId, ...parsed.data })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, schedule: data })
}

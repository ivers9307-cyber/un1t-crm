// GET/PUT /api/locations/[id]/send-quiet-hours
//
// GAPS-P4 — read + write the per-location send-time quiet window
// (company_settings.send_quiet_hours_*, mig 514):
//   { enabled: true, start_hour: 21, end_hour: 8 }
//
// ADVISORY ONLY. No send path reads this. It drives an inline notice in the
// composers that names the Dublin wall-clock time a send would land on and
// offers the next acceptable slot; the send button is never blocked and
// nothing is clamped server-side. See src/lib/send-quiet-hours.js for the
// rationale and the live data behind the defaults.
//
// A location with no company_settings row is normal (most have never saved
// branding), so GET synthesises the defaults rather than 404ing, and PUT
// upserts. The upsert touches ONLY the quiet-hours columns, so it can never
// clobber logo_url / favicon_url / company_name on an existing row.
//
// Auth mirrors comms-frequency-cap: any authenticated user at the location
// READS (the composer needs it); owner + master WRITE.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  normalizeQuietHours,
  QUIET_HOURS_COLUMNS,
  DEFAULT_SEND_QUIET_HOURS,
} from '@/lib/send-quiet-hours'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const QuietHoursSchema = z.object({
  enabled: z.boolean(),
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(0).max(23),
}).refine((v) => v.start_hour !== v.end_hour, {
  message: 'Start and end hour must differ. Switch quiet hours off instead of setting a zero-length window.',
  path: ['end_hour'],
})

function canEditQuietHours(user) {
  if (!user) return false
  if (user.isMaster || user.role === 'master') return true
  return user.role === 'owner'
}

function shape(row, canEdit) {
  const cfg = normalizeQuietHours(row)
  return {
    enabled: cfg.enabled,
    start_hour: cfg.startHour,
    end_hour: cfg.endHour,
    default_start_hour: DEFAULT_SEND_QUIET_HOURS.startHour,
    default_end_hour: DEFAULT_SEND_QUIET_HOURS.endHour,
    can_edit: canEdit,
  }
}

const SELECT_COLS = `${QUIET_HOURS_COLUMNS.enabled}, ${QUIET_HOURS_COLUMNS.start}, ${QUIET_HOURS_COLUMNS.end}`

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('company_settings')
    .select(SELECT_COLS)
    .eq('location_id', locationId)
    .limit(1)

  // No row (or a hiccup) is not an error condition — the code-side default in
  // send-quiet-hours.js is the whole point, so a missing row cannot silently
  // mean "no quiet hours".
  const row = (!error && data && data[0]) || null
  return NextResponse.json({ success: true, data: shape(row, canEditQuietHours(user)) })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditQuietHours(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit send quiet hours.',
    }, { status: 403 })
  }

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const validation = await validateBody(request, QuietHoursSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data, error } = await db
    .from('company_settings')
    .upsert({
      location_id: locationId,
      [QUIET_HOURS_COLUMNS.enabled]: body.enabled,
      [QUIET_HOURS_COLUMNS.start]: body.start_hour,
      [QUIET_HOURS_COLUMNS.end]: body.end_hour,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id' })
    .select(SELECT_COLS)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: shape(data, true) })
}

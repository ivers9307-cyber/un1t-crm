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
// READS (the composer needs it); owner + master AT THE TARGET LOCATION write.
//
// MAILFIX-BRANDGATE.2 — the role is judged AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `user.role === 'owner'` check let an
// owner at studio A who is plain STAFF at studio B PUT
// /api/locations/<B>/send-quiet-hours and change when B's messages may send,
// with a 200. Same shape and order as the #1586 branding routes /
// guardMailboxAdmin: membership first (assertLocationAccess —
// guardMasterOrOwner never checks membership, a master belongs nowhere), so
// an owner of a DIFFERENT studio is told "not one of your locations" rather
// than a role complaint that confirms the studio exists; then owner-or-master
// at the target. Role miss keeps this route's own copy over the guard's
// generic one.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
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

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner. No second role
// predicate lives in this file.
function canEditQuietHours(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
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
  return NextResponse.json({ success: true, data: shape(row, canEditQuietHours(user, locationId)) })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Target FIRST — the id is already on the path — then membership, then the
  // role AT THAT TARGET (see the header for why not `user.role`). Both gates
  // precede validation so a refused caller learns nothing about the schema.
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canEditQuietHours(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit send quiet hours.',
    }, { status: 403 })
  }

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

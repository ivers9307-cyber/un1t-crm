// GET/PUT /api/locations/[id]/comms-frequency-cap
//
// FREQ-CAP.1 — read + write the per-location cross-channel marketing
// frequency cap (locations.settings.comms_frequency_cap):
//   { enabled: false, min_hours_between: 24 }
// OFF by default — turning it on silently would block sends operators
// expect. When enabled, one contact receives at most one MARKETING
// touch (email campaign / WA blast / WA drip / sequence email+WA step)
// per min_hours_between window; transactional sends are unaffected.
// Enforcement lives in src/lib/frequency-cap.js + the send engines.
//
// Auth mirrors notification-config: any authenticated user at the
// location can READ; owner + master AT THE TARGET LOCATION write (the cap
// changes what every campaign/broadcast at the location does — an
// operator-level knob).
//
// MAILFIX-BRANDGATE.2 — the role is judged AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `user.role === 'owner'` check let an
// owner at studio A who is plain STAFF at studio B PUT
// /api/locations/<B>/comms-frequency-cap and switch B's cap with a 200.
// Same shape and order as the #1586 branding routes / guardMailboxAdmin:
// membership first (assertLocationAccess — guardMasterOrOwner never checks
// membership, a master belongs nowhere), so an owner of a DIFFERENT studio
// is told "not one of your locations" rather than a role complaint that
// confirms the studio exists; then owner-or-master at the target. Both run
// before the row is fetched, so a non-member never reaches the database.
// Role miss keeps this route's own copy over the guard's generic one.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import {
  frequencyCapFromLocationSettings,
  FREQUENCY_CAP_MIN_HOURS,
  FREQUENCY_CAP_MAX_HOURS,
} from '@/lib/frequency-cap'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FrequencyCapSchema = z.object({
  enabled: z.boolean(),
  min_hours_between: z.number().int()
    .min(FREQUENCY_CAP_MIN_HOURS)
    .max(FREQUENCY_CAP_MAX_HOURS),
})

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner. No second role
// predicate lives in this file.
function canEditFrequencyCap(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
}

function shape(settings, canEdit) {
  const s = frequencyCapFromLocationSettings(settings)
  return { enabled: s.enabled, min_hours_between: s.minHoursBetween, can_edit: canEdit }
}

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', params.id)
    .single()
  if (error || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

  return NextResponse.json({
    success: true,
    data: shape(location.settings, canEditFrequencyCap(user, location.id)),
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Target FIRST — the id is already on the path — then membership, then the
  // role AT THAT TARGET (see the header for why not `user.role`). Both gates
  // precede validation and the row fetch, so a refused caller learns nothing
  // about the schema and a non-member cannot tell 403 from 404.
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canEditFrequencyCap(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit the marketing frequency cap.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, FrequencyCapSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // The row is read for the MERGE below; membership was already judged on
  // the same id above (the query pins `id = locationId`), so no second check.
  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  // Merge — never clobber sibling settings keys (glofox, webhooks, …).
  const updatedSettings = {
    ...(location.settings || {}),
    comms_frequency_cap: {
      enabled: body.enabled,
      min_hours_between: body.min_hours_between,
    },
  }

  const { data, error } = await db
    .from('locations')
    .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
    .eq('id', locationId)
    .select('id, settings')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: shape(data.settings, true) })
}

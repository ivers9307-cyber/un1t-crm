// GET/PUT /api/locations/[id]/notification-config
//
// Read + write the per-location push-notification config (the JSONB
// stored in locations.notification_config — mig 170). Controls lead
// times for the send-push-reminders cron and the notify-role set for
// booking reminders.
//
// Auth: any authenticated user at the location can READ. owner +
// master AT THE TARGET LOCATION can WRITE — lead times affect every staff
// member at the location, so it's an operator-level decision (matches the
// trust model for shift templates + location features that owners already
// edit). canEditLocationFeatures is master-only and overkill here.
//
// MAILFIX-BRANDGATE.2 — the role is judged AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old `user.role === 'owner'` check let an
// owner at studio A who is plain STAFF at studio B PUT
// /api/locations/<B>/notification-config and rewrite B's reminder config
// with a 200. Same shape and order as the #1586 branding routes /
// guardMailboxAdmin: membership first (assertLocationAccess —
// guardMasterOrOwner never checks membership, a master belongs nowhere), so
// an owner of a DIFFERENT studio is told "not one of your locations" rather
// than a role complaint that confirms the studio exists; then owner-or-master
// at the target. Both run before the row is fetched, so a non-member never
// reaches the database. Role miss keeps this route's own copy over the
// guard's generic one.
//
// PUT body shape:
//   {
//     categories: {
//       tasks:    { lead_times_minutes: [60, 1440] },
//       bookings: { lead_times_minutes: [60, 1440],
//                   notify_roles: ['owner','manager','head_coach'] }
//     }
//   }
// Validation lives in src/lib/notification-config.js validateConfig()
// so the settings UI can use the same checker for instant feedback.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  getEffectiveConfig, validateConfig,
} from '@/lib/notification-config'
import { validateBody } from '@/lib/validate'

// Permissive shape — domain validation is done by validateConfig().
const NotificationConfigSchema = z.object({
  categories: z.record(z.any()).optional(),
}).passthrough()

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Thin wrapper over the REAL guard, so GET's `can_edit` and PUT's gate cannot
// drift apart: the card never offers a Save the server will refuse, and never
// hides the editor from the target studio's actual owner. No second role
// predicate lives in this file.
function canEditNotificationConfig(user, locationId) {
  if (!user) return false
  return guardMasterOrOwner(user, locationId) === null
}

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, slug, name, notification_config')
    .eq('id', params.id)
    .single()
  if (error || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

  return NextResponse.json({
    success: true,
    data: {
      // The raw stored value (null = defaults). Surface both raw +
      // effective so the UI can show "(default)" badges next to
      // unset categories.
      stored: location.notification_config,
      effective: getEffectiveConfig(location.notification_config),
      can_edit: canEditNotificationConfig(user, location.id),
    },
  })
}

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  // Target FIRST — the id is already on the path — then membership, then the
  // role AT THAT TARGET (see the header for why not `user.role`). Both gates
  // precede validation and the row fetch, so a refused caller learns nothing
  // about the schema and a non-member cannot tell 403 from 404.
  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canEditNotificationConfig(user, locationId)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit notification config.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, NotificationConfigSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const v = validateConfig(body)
  if (!v.ok) {
    return NextResponse.json({ success: false, error: 'Validation failed', errors: v.errors }, { status: 400 })
  }

  // Existence check only; membership was already judged on the same id
  // above (the query pins `id = locationId`), so no second check.
  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id')
    .eq('id', locationId)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  const { data, error } = await db
    .from('locations')
    .update({
      notification_config: v.value,
      updated_at: new Date().toISOString(),
    })
    .eq('id', locationId)
    .select('id, notification_config')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({
    success: true,
    data: {
      stored: data.notification_config,
      effective: getEffectiveConfig(data.notification_config),
      can_edit: true,
    },
  })
}

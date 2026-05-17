// GET/PUT /api/locations/[id]/notification-config
//
// Read + write the per-location push-notification config (the JSONB
// stored in locations.notification_config — mig 170). Controls lead
// times for the send-push-reminders cron and the notify-role set for
// booking reminders.
//
// Auth: any authenticated user at the location can READ. owner +
// master can WRITE — lead times affect every staff member at the
// location, so it's an operator-level decision (matches the trust
// model for shift templates + location features that owners already
// edit). canEditLocationFeatures is master-only and overkill here.
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
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import {
  getEffectiveConfig, validateConfig,
} from '@/lib/notification-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function canEditNotificationConfig(user) {
  if (!user) return false
  if (user.isMaster || user.role === 'master') return true
  return user.role === 'owner'
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
      can_edit: canEditNotificationConfig(user),
    },
  })
}

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditNotificationConfig(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit notification config.',
    }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (body === null) {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const v = validateConfig(body)
  if (!v.ok) {
    return NextResponse.json({ success: false, error: 'Validation failed', errors: v.errors }, { status: 400 })
  }

  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id')
    .eq('id', params.id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

  const { data, error } = await db
    .from('locations')
    .update({
      notification_config: v.value,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
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

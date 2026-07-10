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
// location can READ; owner + master WRITE (the cap changes what every
// campaign/broadcast at the location does — an operator-level knob).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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

function canEditFrequencyCap(user) {
  if (!user) return false
  if (user.isMaster || user.role === 'master') return true
  return user.role === 'owner'
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
    data: shape(location.settings, canEditFrequencyCap(user)),
  })
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditFrequencyCap(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only owners and masters can edit the marketing frequency cap.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, FrequencyCapSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', params.id)
    .single()
  if (locErr || !location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, location.id)
  if (guard) return guard

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
    .eq('id', params.id)
    .select('id, settings')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: shape(data.settings, true) })
}

// LIEU.1 — per-studio payroll rule: the Sunday time-in-lieu multiplier
// (locations.settings.payroll.sunday_multiplier, default 4/3 = time and a
// third). Read by the nightly lieu sweep, the Staff Cost report and the WRC
// pack through sundayLieuMultiplier (src/lib/lieu-rules.js).
//
//   GET  → { sunday_multiplier, default_sunday_multiplier, is_default, can_edit }
//   PUT  { sunday_multiplier: number|null }  null = back to the default
//
// Gate (the geofence-attendance route's shape): membership first
// (assertLocationAccess), then master or owner AT this studio for the write
// (guardMasterOrOwner). Any member may read: the figure is a rule, not pay.
// The settings jsonb is merged through mergeLocationSettings (SETTINGSWIPE.1),
// never clobbered (sibling keys: glofox, geofence, …). `payroll.sunday_multiplier` is not a secret-named key, so the
// audit trigger records it in clear, which is right.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import {
  sundayLieuMultiplier, DEFAULT_SUNDAY_LIEU_MULTIPLIER, SUNDAY_MULTIPLIER_MIN, SUNDAY_MULTIPLIER_MAX,
} from '@/lib/lieu-rules'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PayrollSettingsSchema = z.object({
  sunday_multiplier: z.number().finite().min(SUNDAY_MULTIPLIER_MIN).max(SUNDAY_MULTIPLIER_MAX).nullable(),
})

function shape(settings, canEdit) {
  const stored = settings?.payroll?.sunday_multiplier
  const effective = sundayLieuMultiplier(settings)
  return {
    sunday_multiplier: Math.round(effective * 10000) / 10000,
    default_sunday_multiplier: Math.round(DEFAULT_SUNDAY_LIEU_MULTIPLIER * 10000) / 10000,
    is_default: stored === null || stored === undefined || stored === '' || sundayLieuMultiplier(settings) !== Number(stored),
    min: SUNDAY_MULTIPLIER_MIN,
    max: SUNDAY_MULTIPLIER_MAX,
    can_edit: canEdit,
  }
}

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: location, error } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = not found
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!location) return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })

  const canEdit = guardMasterOrOwner(user, locationId) === null
  return NextResponse.json({ success: true, data: shape(location.settings, canEdit) })
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can change the Sunday lieu multiplier.' }, { status: 403 })
  }

  const validation = await validateBody(request, PayrollSettingsSchema)
  if (!validation.ok) return validation.response
  const { sunday_multiplier } = validation.data

  // SETTINGSWIPE.1 — the one way a route changes locations.settings: the read
  // is judged (a failed read writes nothing) and sibling keys are kept.
  const db = createServerClient()
  const result = await mergeLocationSettings(db, locationId, (current) => {
    const payroll = { ...(current.payroll || {}) }
    if (sunday_multiplier === null) delete payroll.sunday_multiplier
    else payroll.sunday_multiplier = sunday_multiplier
    return { ...current, payroll }
  }, { scope: 'payroll-settings' })
  if (!result.ok) return settingsSaveFailure(result)
  return NextResponse.json({ success: true, data: shape(result.settings, true) })
}

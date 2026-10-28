// FEES.1 — PUT the class-fee settings of one studio
// (locations.settings.un1t_online.fees). Master or owner at that studio.
// Body { location_id, enabled, charging_paused, late_cancel_fee_cents,
// no_show_fee_cents, review_emails }. The late-cancel window is
// un1t.online's own and is not set here.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { classFeeSettingsFrom, MAX_FEE_CENTS } from '@/lib/class-fees'

export const runtime = 'nodejs'

const cents = z.number().int().min(0).max(MAX_FEE_CENTS)
export const ClassFeeSettingsSchema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  charging_paused: z.boolean(),
  late_cancel_fee_cents: cents,
  no_show_fee_cents: cents,
  review_emails: z.array(z.string().trim().email().max(254)).max(10),
  // FEES.2 — the automatic forgiveness rules. Optional: a client that never
  // sends them leaves the stored rules as they are.
  forgiveness: z.object({
    swap: z.boolean(),
    swap_minutes: z.number().int().min(5).max(240),
    spot_refilled: z.boolean(),
    new_member: z.boolean(),
    new_member_days: z.number().int().min(1).max(90),
    first_offence: z.boolean(),
    first_offence_days: z.number().int().min(7).max(365),
    monthly_cap: z.boolean(),
    monthly_cap_count: z.number().int().min(1).max(31),
  }).optional(),
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const validation = await validateBody(request, ClassFeeSettingsSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, forgiveness, ...fees } = validation.data
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) return roleGuard

  const db = createServerClient()
  const result = await mergeLocationSettings(db, locationId, (current) => {
    const un1t = current.un1t_online && typeof current.un1t_online === 'object' ? current.un1t_online : {}
    return {
      ...current,
      un1t_online: {
        ...un1t,
        fees: {
          ...(un1t.fees && typeof un1t.fees === 'object' ? un1t.fees : {}),
          enabled: fees.enabled,
          charging_paused: fees.charging_paused,
          late_cancel_fee_cents: fees.late_cancel_fee_cents,
          no_show_fee_cents: fees.no_show_fee_cents,
          review_emails: fees.review_emails.map((e) => e.toLowerCase()),
          ...(forgiveness ? { forgiveness } : {}),
        },
      },
    }
  }, { scope: 'class-fees-settings' })
  if (!result.ok) return settingsSaveFailure(result)
  return NextResponse.json({ success: true, data: classFeeSettingsFrom(result.settings) })
}

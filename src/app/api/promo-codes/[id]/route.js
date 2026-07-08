// /api/promo-codes/[id]
//
// Update / delete a single discount code (EVENTS-PROMO.1). Manager+ with the
// `races` permission. Everything is scoped to the caller's ACTIVE location —
// a code at another location (or a bogus id) returns 404, never 403, so ids
// can't be enumerated across tenants.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SELECT_COLS =
  'id, location_id, event_id, code, discount_type, discount_value, max_redemptions, redeemed_count, member_only, expires_at, active, created_at'

// Operator-editable fields. code + event_id + location_id are immutable once
// created (recreate to change the code). max_redemptions/expires_at accept
// null to clear (unlimited / never expires).
const UpdateSchema = z
  .object({
    active: z.boolean().optional(),
    expires_at: z.string().datetime().nullable().optional(),
    max_redemptions: z.number().int().min(1).nullable().optional(),
    member_only: z.boolean().optional(),
    discount_type: z.enum(['percent', 'fixed']).optional(),
    discount_value: z.number().int().min(0).optional(),
  })
  // Percent cap: only enforceable here when both fields are present in the
  // patch; a partial patch (e.g. value without type) is caught by the DB
  // CHECK constraint (promo_percent_max_100) and surfaced as a 400 below.
  .refine((d) => !(d.discount_type === 'percent' && d.discount_value != null && d.discount_value > 100), {
    message: 'A percent discount cannot exceed 100.',
    path: ['discount_value'],
  })

// Authenticated Manager+ with the `races` permission and an active location.
async function authorize() {
  const user = await getCurrentUser()
  if (!user) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 }) }
  }
  if (!MANAGER_ROLES.includes(user.role) || !hasPermission(user, 'races')) {
    return { response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return { response: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  }
  return { user, locationId }
}

export async function PATCH(request, props) {
  const params = await props.params
  const gate = await authorize()
  if (gate.response) return gate.response
  const { locationId } = gate

  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response

  const updates = {}
  for (const [k, v] of Object.entries(validation.data)) {
    if (v !== undefined) updates[k] = v
  }

  const db = createServerClient()

  // Existence + tenancy check up front: a cross-location or missing id both
  // 404 (no IDOR / no enumeration).
  const { data: existing } = await db
    .from('promo_codes')
    .select('id')
    .eq('id', params.id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await db
    .from('promo_codes')
    .update(updates)
    .eq('id', params.id)
    .eq('location_id', locationId)
    .select(SELECT_COLS)
    .single()

  if (error) {
    // 23514 = check_violation (e.g. percent > 100 on a partial patch).
    if (error.code === '23514' || /check constraint|promo_percent_max_100/i.test(error.message || '')) {
      return NextResponse.json({ success: false, error: 'A percent discount cannot exceed 100.' }, { status: 400 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const gate = await authorize()
  if (gate.response) return gate.response
  const { locationId } = gate

  const db = createServerClient()

  // 404 for both missing and cross-location before deleting.
  const { data: existing } = await db
    .from('promo_codes')
    .select('id')
    .eq('id', params.id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Hard delete. race_registrations.promo_code_id is ON DELETE SET NULL, so
  // past redemptions keep their record (promo_code_id nulled).
  const { error } = await db.from('promo_codes').delete().eq('id', params.id).eq('location_id', locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

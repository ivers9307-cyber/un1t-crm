// /api/promo-codes
//
// Operator CRUD for event checkout discount codes (EVENTS-PROMO.1).
// List + create, scoped to the caller's ACTIVE location. Manager+ AND the
// `races` permission are required — a discount is a money lever, so it's
// gated the same as the events/races surface it applies to.
//
// The money-path (validation + redemption) lives in the public register
// route and src/lib/promo-codes.js — this file is the admin surface only.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { normalizeCode } from '@/lib/promo-codes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Columns returned to the operator UI (includes redeemed_count for the
// "X of Y used" display).
const SELECT_COLS =
  'id, location_id, event_id, code, discount_type, discount_value, max_redemptions, redeemed_count, member_only, expires_at, active, created_at'

const CreateSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    discount_type: z.enum(['percent', 'fixed']),
    // percent: 0-100 (refined below); fixed: cents.
    discount_value: z.number().int().min(0),
    // Optional — omit/NULL = applies to any event at the location.
    event_id: uuidLike.optional(),
    max_redemptions: z.number().int().min(1).optional(),
    member_only: z.boolean().optional(),
    expires_at: z.string().datetime().optional(),
  })
  .refine((d) => d.discount_type !== 'percent' || d.discount_value <= 100, {
    message: 'A percent discount cannot exceed 100.',
    path: ['discount_value'],
  })

// Shared gate: authenticated Manager+ with the `races` permission at their
// active location. Returns { user, locationId } on success or { response }.
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

export async function GET(request) {
  const gate = await authorize()
  if (gate.response) return gate.response
  const { locationId } = gate

  const eventId = new URL(request.url).searchParams.get('event_id')

  const db = createServerClient()
  let query = db
    .from('promo_codes')
    .select(SELECT_COLS)
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })

  if (eventId) {
    if (!uuidLike.safeParse(eventId).success) {
      return NextResponse.json({ success: false, error: 'Invalid event_id' }, { status: 400 })
    }
    query = query.eq('event_id', eventId)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const gate = await authorize()
  if (gate.response) return gate.response
  const { locationId } = gate

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  // When tied to an event, it must be a race_event at THIS location — a
  // cross-location id (or a bogus one) is rejected, never leaked.
  if (body.event_id) {
    const { data: ev } = await db
      .from('race_events')
      .select('id')
      .eq('id', body.event_id)
      .eq('location_id', locationId)
      .maybeSingle()
    if (!ev) {
      return NextResponse.json(
        { success: false, error: 'That event was not found at this location.', code: 'invalid_event' },
        { status: 400 }
      )
    }
  }

  const { data, error } = await db
    .from('promo_codes')
    .insert({
      location_id: locationId,
      event_id: body.event_id ?? null,
      code: normalizeCode(body.code),
      discount_type: body.discount_type,
      discount_value: body.discount_value,
      max_redemptions: body.max_redemptions ?? null,
      member_only: body.member_only ?? false,
      expires_at: body.expires_at ?? null,
    })
    .select(SELECT_COLS)
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      return NextResponse.json(
        { success: false, error: 'A code with that name already exists at this location.', code: 'duplicate_code' },
        { status: 409 }
      )
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data }, { status: 201 })
}

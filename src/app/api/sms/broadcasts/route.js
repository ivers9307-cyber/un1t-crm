// /api/sms/broadcasts — list + create.
//
// Auth-gated by the 'sms' permission at the active location
// (per-location override layer from mig 058).
//
// Mirrors /api/whatsapp/broadcasts/route.js.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema } from '@/lib/schemas'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'

export const runtime = 'nodejs'

const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(1600),
  audience_filter: audienceFilterSchema.optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  location_id: uuidLike.optional(),
  // Create directly as 'scheduled' (with scheduled_at) so the composer
  // doesn't need a second PATCH to flip the status — that 2-step left a
  // stranded draft if the PATCH failed. Only draft/scheduled are settable
  // here; sending/sent are owned by the send loop + /send endpoint.
  status: z.enum(['draft', 'scheduled']).optional(),
})

// GET /api/sms/broadcasts?location_id=xxx — list broadcasts at a
// location (or across the caller's locations if location_id omitted).
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('sms_broadcasts')
    .select('id, name, body, status, audience_filter, scheduled_at, sent_at, total_recipients, total_sent, total_failed, location_id, created_by, created_at, updated_at')
    .order('created_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, broadcasts: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, broadcasts: data })
}

// POST /api/sms/broadcasts — create draft broadcast.
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'sms')) {
    return NextResponse.json({ success: false, error: 'Forbidden — SMS not enabled' }, { status: 403 })
  }

  const validation = await validateBody(request, BroadcastCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // COMMSFIX.B.7 — reject an invalid audience filter at save time instead of
  // parking a broadcast whose audience can never resolve.
  try {
    validateAudienceFilter(body.audience_filter)
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }

  // 'scheduled' requires a scheduled_at; otherwise it'd sit invisible to
  // the cron (which picks up status='scheduled' AND scheduled_at <= now).
  const status = body.status === 'scheduled' && body.scheduled_at ? 'scheduled' : 'draft'

  const db = createServerClient()
  const { data, error } = await db.from('sms_broadcasts').insert({
    location_id: locationId,
    name: body.name,
    body: body.body,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    status,
    scheduled_at: body.scheduled_at || null,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, broadcast: data })
}

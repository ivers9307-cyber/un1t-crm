import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, audienceFilterSchema, url, timeOfDay } from '@/lib/schemas'

const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_id: uuidLike,
  variable_mapping: z.unknown().optional(),
  header_media_url: url.nullable().optional(),
  audience_filter: audienceFilterSchema,
  location_id: uuidLike.optional(),
  // WA-DRIP — paced delivery. Defaults keep the blast path identical.
  delivery_mode: z.enum(['blast', 'drip']).optional().default('blast'),
  daily_cap: z.number().int().positive().max(100000).optional(),
  per_tick_max: z.number().int().positive().max(5000).optional(),
  send_window_start: timeOfDay.optional(),
  send_window_end: timeOfDay.optional(),
  send_window_tz: z.string().max(64).optional(),
  // AGENT-TAKEOVER — operator will handle replies on a bulk send, so pause Mia
  // on each recipient thread. (A single-recipient send pauses automatically.)
  handle_replies_manually: z.boolean().optional(),
})

// GET /api/whatsapp/broadcasts
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('whatsapp_broadcasts')
    .select('*, whatsapp_templates(name, category, status)')
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

// POST /api/whatsapp/broadcasts
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, BroadcastCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const isDrip = body.delivery_mode === 'drip'
  const { data, error } = await db.from('whatsapp_broadcasts').insert({
    name: body.name || 'Untitled Broadcast',
    template_id: body.template_id,
    variable_mapping: body.variable_mapping || {},
    header_media_url: body.header_media_url || null,
    audience_filter: body.audience_filter || { filters: [], logic: 'and' },
    // A drip starts immediately — the run-whatsapp-broadcasts cron drives it during
    // the send window. A blast stays 'draft' until the operator fires /send.
    status: isDrip ? 'sending' : 'draft',
    delivery_mode: body.delivery_mode || 'blast',
    handle_replies_manually: body.handle_replies_manually === true,
    ...(isDrip ? {
      daily_cap: body.daily_cap ?? 500,
      per_tick_max: body.per_tick_max ?? null,
      send_window_start: body.send_window_start || '09:00',
      send_window_end: body.send_window_end || '20:00',
      send_window_tz: body.send_window_tz || 'Europe/Dublin',
    } : {}),
    location_id: locationId,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, broadcast: data })
}

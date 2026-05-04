import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const SequenceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  // Must match what the runner (lib/sequences.js) handles AND the
  // editor offers (SequenceEditor.jsx TRIGGER_TYPES). The previous
  // enum had stale draft values ('on_signup' / 'on_status_change')
  // that would silently reject legitimate sequences from the editor.
  trigger_type: z.enum([
    'manual', 'booking_created', 'first_booking', 'status_change',
    'event_reminder', 'tag_added',
    'race_registered', 'race_finished',
    'order_completed', 'order_failed', 'order_abandoned',
    'anniversary', 'inactivity',
  ]).optional(),
  trigger_config: z.unknown().optional(),
  goal_config: z.unknown().nullable().optional(),
  send_window: z.unknown().nullable().optional(),
  // Mig 090 (Tier 3C): NULL/0 = single-enrolment-per-contact (default).
  // > 0 = same contact may re-enrol after their previous run ended that
  // many days ago. Capped at ~10 years to avoid silly inputs.
  re_enrolment_cooldown_days: z.number().int().min(0).max(3650).nullable().optional(),
  location_id: uuidLike.optional(),
})

// GET /api/sequences — list sequences
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('email_sequences')
    .select('*, sequence_steps(count)')
    .order('created_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, sequences: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequences: data })
}

// POST /api/sequences — create sequence
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SequenceCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('email_sequences').insert({
    name: body.name || 'Untitled Sequence',
    description: body.description || null,
    trigger_type: body.trigger_type || 'manual',
    trigger_config: body.trigger_config || {},
    goal_config: body.goal_config ?? null,
    send_window: body.send_window ?? null,
    re_enrolment_cooldown_days: body.re_enrolment_cooldown_days ?? null,
    status: 'draft',
    location_id: locationId,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequence: data })
}
